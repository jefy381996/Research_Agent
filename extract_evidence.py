#!/usr/bin/env python3
"""Extract performance evidence from paper text, deterministically.

Design, and why it is built this way
------------------------------------
Every row is scoped to a single sentence. A row is emitted only when that
sentence states a capacity or a retention figure, and every other number in
the row is read from the same sentence. That makes two of the brief's hard
rules true by construction rather than by inspection:

  * Every stored number carries its source sentence, because the sentence is
    where the number was found.
  * A row is internally coherent, because its numbers were reported together.

Text verification (check A) still runs: the digits of each extracted value
must appear in the stored quote, and the quote must appear in the source text.
A field that fails becomes NULL and the reason is logged. The check cannot
fail by accident here, which is the point - it is a regression test on the
extractor, not a filter on a model's imagination.

Categorical fields (material system, graphene form, electrode role, battery
type) are classifications, not measurements. They are derived from matched
vocabulary and carry no numeric claim, so they are not subject to check A.

An optional LLM pass is available behind EXTRACTOR=llm for cases a rule misses,
but the default path needs no network, no key, and returns the same answer
every time it runs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone

import db
import plausibility

# --- text normalisation -----------------------------------------------------
# Applied to a working copy only. The stored quote stays as the paper wrote it.
_SUBS = [
    ("−", "-"), ("–", "-"), ("—", "-"), ("‐", "-"),
    (" ", " "), (" ", " "), (" ", " "), ("​", ""),
    ("⁻¹", "-1"), ("⁻²", "-2"), ("¹", "1"),
    ("²", "2"), ("³", "3"), ("·", " "), ("•", " "),
    ("′", "'"), ("∼", "~"), ("≈", "~"),
]


def normalise(text: str) -> str:
    for a, b in _SUBS:
        text = text.replace(a, b)
    return re.sub(r"\s+", " ", text)


# --- sentence splitting -----------------------------------------------------
_ABBREV = re.compile(
    r"\b(?:e\.g|i\.e|cf|vs|etc|Fig|Figs|Eq|Eqs|ref|Refs|approx|ca|No|vol|"
    r"wt|at|Dr|Prof|et al)\.$", re.I)


def sentences(text: str) -> list[str]:
    if not text:
        return []
    text = text.strip()
    parts = re.split(r"(?<=[.!?])\s+", text)
    out: list[str] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        # Re-join a fragment split after an abbreviation or a decimal point.
        if out and (_ABBREV.search(out[-1]) or re.search(r"\d\.$", out[-1])
                    or len(part) < 12):
            out[-1] = out[-1] + " " + part
        else:
            out.append(part)
    return [s for s in out if len(s) > 25]


# --- quantity patterns ------------------------------------------------------
NUM = r"(\d{1,6}(?:[.,]\d+)?)"

CAPACITY_RE = re.compile(
    NUM + r"\s*(mA\s?h\s*(?:/|\s)?\s*g(?:\s*-\s*1)?|A\s?h\s*(?:/|\s)?\s*kg"
          r"(?:\s*-\s*1)?|mA\s?h\s*(?:/|\s)?\s*mg(?:\s*-\s*1)?)", re.I)

CURRENT_RE = re.compile(
    NUM + r"\s*(mA\s*(?:/|\s)?\s*g(?:\s*-\s*1)?|A\s*(?:/|\s)?\s*g"
          r"(?:\s*-\s*1)?|A\s*(?:/|\s)?\s*kg(?:\s*-\s*1)?)(?![a-z])", re.I)

# C-rate: a bare C not preceded by a degree sign and not inside a word.
CRATE_RE = re.compile(
    r"(?<![\w°º])" + NUM + r"\s*C(?:\s*-?\s*rate)?(?![\w°/])", re.I)

CYCLES_RE = re.compile(
    r"(?:after|over|within|for|during|up\s+to|following)?\s*"
    r"(\d{1,6})\s*(?:charge\s*[-/]?\s*discharge\s*)?cycles", re.I)

RETENTION_RE = [
    re.compile(NUM + r"\s*%\s*(?:of\s+)?(?:its\s+|the\s+)?"
                     r"(?:initial\s+|original\s+|reversible\s+)?"
                     r"(?:capacity\s+)?retention", re.I),
    re.compile(r"retention\s*(?:rate\s*)?(?:of|was|is|reaching|reached|remains?|"
               r"remaining|at)?\s*" + NUM + r"\s*%", re.I),
    re.compile(r"retain(?:ed|ing|s)?\s*(?:about\s+|around\s+|~)?" + NUM
               + r"\s*%", re.I),
    re.compile(NUM + r"\s*%\s*(?:capacity\s+)?(?:is\s+|was\s+)?retained", re.I),
]

CE_RE = [
    re.compile(r"(?:initial|first[\s-]*cycle|1st[\s-]*cycle)\s+coulombic\s+"
               r"efficiency\s*(?:of|was|is|reached|reaching|at)?\s*" + NUM
               + r"\s*%", re.I),
    re.compile(r"\bICE\b\s*(?:of|was|is|reached|at)?\s*" + NUM + r"\s*%", re.I),
    re.compile(r"coulombic\s+efficiency\s*(?:of|was|is|reached|reaching|at)?\s*"
               + NUM + r"\s*%", re.I),
]

VOLTAGE_RE = re.compile(
    r"(\d(?:\.\d+)?)\s*(?:-|to|~)\s*(\d(?:\.\d+)?)\s*V\b", re.I)

TEMP_RE = re.compile(r"(-?\d{1,3}(?:\.\d+)?)\s*(?:°|º|\bdeg(?:rees)?\.?\s*)\s*C\b", re.I)

# Words that mark a temperature as belonging to material synthesis rather than
# to a cell test.
SYNTHESIS_RE = re.compile(
    r"anneal|calcin|pyroly|carboniz|carbonis|sinter|heat(?:ed|ing)?|"
    r"furnace|hydrotherm|solvotherm|reduc(?:ed|tion)\s+at|dried|drying|"
    r"thermal\s+treat|CVD|grown\s+at|synthesi", re.I)

LOADING_RE = re.compile(
    NUM + r"\s*mg\s*(?:/|\s)?\s*cm\s*(?:-?\s*2)?", re.I)

FARAD_RE = re.compile(NUM + r"\s*F\s*(?:/|\s)?\s*g", re.I)

# An initial capacity is recorded only when the sentence states the pair
# explicitly. Two capacities in one sentence are usually a rate-capability
# comparison at two currents, not a start and an end, so nothing is inferred.
FROM_TO_RE = re.compile(
    r"from\s+" + NUM + r"\s*(?:mA\s?h|mAh|A\s?h)[^.]{0,80}?\bto\s+" + NUM, re.I)

# A capacity introduced as a theoretical limit is a textbook constant, not a
# measurement. Abstracts routinely open with "the theoretical capacity of
# silicon is 4200 mAh/g"; storing that as a result would put a number nobody
# measured at the top of the table. The marker is looked for in the words
# immediately before the value, so a sentence that cites a theoretical figure
# AND reports a real one still yields the real one.
THEORETICAL_RE = re.compile(
    r"theoretic|in\s+theory|maximum\s+possible", re.I)

# Distance alone cannot separate the two cases. "The theoretical capacity of
# silicon can reach up to 4200 mAh/g" is a textbook constant; "exceeding the
# theoretical capacity of graphite (372 mAh/g), the anode delivered 1250
# mAh/g" reports a real measurement in the same breath. What distinguishes
# them is a finite measurement verb standing between the theoretical phrase
# and the value. Infinitives such as "can reach" are deliberately excluded.
MEASURED_RE = re.compile(
    r"\b(?:deliver(?:ed|s|ing)|exhibit(?:ed|s|ing)|achiev(?:ed|es|ing)|"
    r"retain(?:ed|s|ing)|show(?:ed|s|ing|n)|demonstrat(?:ed|es|ing)|"
    r"maintain(?:ed|s|ing)|obtain(?:ed|s|ing)|display(?:ed|s|ing)|"
    r"yield(?:ed|s|ing)|provid(?:ed|es|ing)|attain(?:ed|s|ing)|"
    r"reach(?:ed|es)|record(?:ed|s)|measur(?:ed|es)|"
    r"present(?:ed|s)|offer(?:ed|s)|possess(?:ed|es))\b", re.I)

# --- classification vocabulary ---------------------------------------------
GRAPHENE_FORMS = [
    ("rGO", (r"reduced\s+graphene\s+oxide", r"\brGO\b", r"\br-GO\b")),
    ("graphene oxide", (r"graphene\s+oxide", r"\bGO\b")),
    ("N-doped graphene", (r"(?:nitrogen|N)\s*-?\s*doped\s+graphene",
                          r"\bNG\b", r"N-rGO")),
    ("graphene aerogel", (r"graphene\s+(?:aerogel|hydrogel)",)),
    ("3D graphene", (r"3\s*-?\s*D\s+graphene", r"three\s*-?\s*dimensional\s+graphene",
                     r"graphene\s+framework")),
    ("graphene foam", (r"graphene\s+foam",)),
    ("holey graphene", (r"holey\s+graphene", r"porous\s+graphene")),
    ("graphene quantum dots", (r"graphene\s+quantum\s+dot",)),
    ("CVD graphene", (r"\bCVD\b[\s-]*graphene", r"chemical\s+vapou?r\s+deposition")),
    ("few-layer graphene", (r"few\s*-?\s*layer(?:ed)?\s+graphene",
                            r"multi\s*-?\s*layer(?:ed)?\s+graphene")),
    ("graphene nanosheets", (r"graphene\s+nano\s*sheet", r"graphene\s+sheet",
                             r"graphene\s+nanoplatelet")),
    ("graphene", (r"\bgraphene\b", r"\bgraphitic\b")),
]

BATTERY_TYPES = [
    ("lithium-sulfur", (r"lithium\s*-?\s*sulfur", r"lithium\s*-?\s*sulphur",
                        r"\bLi\s*-?\s*S\b", r"\bLiS\b")),
    ("lithium-selenium", (r"lithium\s*-?\s*selenium", r"\bLi\s*-?\s*Se\b")),
    ("lithium-air", (r"lithium\s*-?\s*(?:air|oxygen)", r"\bLi\s*-?\s*O\s*2\b")),
    ("lithium metal", (r"lithium\s+metal\s+(?:batter|anode)",
                       r"\bLMB\b", r"lithium\s+dendrite")),
    ("solid-state", (r"(?:all\s*-?\s*)?solid\s*-?\s*state\s+(?:batter|electrolyte)",
                     r"\bASSB\b")),
    ("sodium-ion", (r"sodium\s*-?\s*ion", r"\bNa\s*-?\s*ion\b", r"\bSIB\b")),
    ("potassium-ion", (r"potassium\s*-?\s*ion", r"\bK\s*-?\s*ion\b", r"\bPIB\b")),
    ("zinc-ion", (r"zinc\s*-?\s*ion", r"\bZn\s*-?\s*ion\b", r"\bZIB\b")),
    ("magnesium-ion", (r"magnesium\s*-?\s*ion", r"\bMg\s*-?\s*ion\b")),
    ("aluminium-ion", (r"alumini?um\s*-?\s*ion", r"\bAl\s*-?\s*ion\b")),
    ("lithium-ion", (r"lithium\s*-?\s*ion", r"\bLi\s*-?\s*ion\b", r"\bLIB\b",
                     r"\bLIBs\b")),
]

ELECTRODE_ROLES = [
    ("anode", (r"\banode", r"negative\s+electrode")),
    ("cathode", (r"\bcathode", r"positive\s+electrode")),
    ("separator", (r"\bseparator", r"\binterlayer\b")),
    ("current collector", (r"current\s+collector",)),
    ("electrolyte", (r"\belectrolyte\s+additive", r"\bsolid\s+electrolyte")),
]

PARTNERS = [
    # Subscripts arrive space-separated from OpenAlex abstract reconstruction
    # ("MoS 2", "Fe 2 O 3"), so every formula tolerates internal whitespace.
    ("Si", (r"\bsilicon\b", r"\bSiO\s*x\b", r"\bSi\b")),
    ("S", (r"\bsulfur\b", r"\bsulphur\b", r"\bS\s*/\s*C\b")),
    ("SnO2", (r"\bSnO\s*2\b", r"tin\s+oxide")),
    ("Sn", (r"\btin\b", r"\bSn\b")),
    ("Fe2O3", (r"\bFe\s*2\s*O\s*3\b", r"hematite")),
    ("Fe3O4", (r"\bFe\s*3\s*O\s*4\b", r"magnetite")),
    ("Co3O4", (r"\bCo\s*3\s*O\s*4\b",)),
    ("MoS2", (r"\bMoS\s*2\b", r"molybdenum\s+disulfide")),
    ("MnO2", (r"\bMnO\s*2\b", r"manganese\s+dioxide")),
    ("TiO2", (r"\bTiO\s*2\b", r"titania")),
    ("LFP", (r"\bLiFePO\s*4\b", r"\bLFP\b", r"lithium\s+iron\s+phosphate")),
    ("NMC", (r"\bNMC\b", r"\bNCM\b", r"LiNi.{0,14}Mn.{0,14}Co")),
    ("LTO", (r"\bLi\s*4\s*Ti\s*5\s*O\s*12\b", r"\bLTO\b",
             r"lithium\s+titanate")),
    ("V2O5", (r"\bV\s*2\s*O\s*5\b",)),
    ("Nb2O5", (r"\bNb\s*2\s*O\s*5\b",)),
    ("Li2S", (r"\bLi\s*2\s*S\b",)),
    ("Se", (r"\bselenium\b", r"\bSe\b")),
    ("Sb", (r"\bantimony\b", r"\bSb\b")),
    ("Bi", (r"\bbismuth\b", r"\bBi\b")),
    ("Ge", (r"\bgermanium\b", r"\bGe\b")),
    ("P", (r"black\s+phosphor", r"red\s+phosphor", r"\bphosphorene\b")),
    ("NiO", (r"\bNiO\b",)),
    ("CuO", (r"\bCuO\b",)),
    ("ZnO", (r"\bZnO\b",)),
    ("CNT", (r"carbon\s+nanotube", r"\bCNTs?\b")),
    ("hard carbon", (r"hard\s+carbon",)),
]

ELECTROLYTE_RE = [
    ("LiPF6", r"\bLiPF\s*6\b"), ("LiTFSI", r"\bLiTFSI\b"),
    ("NaPF6", r"\bNaPF\s*6\b"), ("NaClO4", r"\bNaClO\s*4\b"),
    ("LiClO4", r"\bLiClO\s*4\b"), ("ZnSO4", r"\bZnSO\s*4\b"),
    ("LiTFSI/DOL-DME", r"\bDOL\s*/\s*DME\b"),
    ("EC/DEC", r"\bEC\s*/\s*DEC\b"), ("EC/DMC", r"\bEC\s*/\s*DMC\b"),
    ("KOH", r"\bKOH\b"), ("H2SO4", r"\bH\s*2\s*SO\s*4\b"),
]

MAX_ROWS_PER_PAPER = 6


def _first_match(vocab, text):
    for label, patterns in vocab:
        for pattern in patterns:
            if re.search(pattern, text, re.I):
                return label
    return None


def _num(raw):
    try:
        return float(str(raw).replace(",", ""))
    except (TypeError, ValueError):
        return None


def classify(title, abstract, sentence):
    """Categorical labels. Sentence wins; paper text is the fallback."""
    paper_text = normalise(f"{title} {abstract}")
    form = _first_match(GRAPHENE_FORMS, sentence) or _first_match(GRAPHENE_FORMS, paper_text)
    btype = _first_match(BATTERY_TYPES, sentence) or _first_match(BATTERY_TYPES, paper_text)
    role = _first_match(ELECTRODE_ROLES, sentence) or _first_match(ELECTRODE_ROLES, paper_text)
    partner = _first_match(PARTNERS, sentence) or _first_match(PARTNERS, paper_text)

    if partner and form:
        material = f"{partner}/{form}"
    elif form:
        material = form
    elif partner:
        material = partner
    else:
        material = None

    electrolyte = None
    for label, pattern in ELECTROLYTE_RE:
        if re.search(pattern, sentence, re.I) or re.search(pattern, paper_text, re.I):
            electrolyte = label
            break
    return material, form, role, btype, electrolyte


def extract_from_sentence(sentence, title, abstract, section):
    """Return a row dict, or None when the sentence states no anchor value."""
    norm = normalise(sentence)
    work = norm

    caps = CAPACITY_RE.findall(work)
    for match in CAPACITY_RE.finditer(norm):          # blank out so mA/g does not
        work = work.replace(match.group(0), " " * len(match.group(0)), 1)

    currents = CURRENT_RE.findall(work)

    retention = None
    for pattern in RETENTION_RE:
        found = pattern.search(norm)
        if found:
            retention = _num(found.group(1))
            break

    # Anchor: a row exists only if the sentence reports a capacity or retention.
    if not caps and retention is None:
        return None


    notes = []
    # Keep each capacity with its position so a theoretical claim can be told
    # apart from a measurement by the words that introduce it.
    measured = []
    skipped_theoretical = 0
    for match in CAPACITY_RE.finditer(norm):
        value = _num(match.group(1))
        if value is None:
            continue
        before = norm[:match.start()]
        claim = THEORETICAL_RE.search(before)
        if claim and not MEASURED_RE.search(before[claim.end():]):
            skipped_theoretical += 1
            continue
        measured.append((value, match.group(1), match.group(2)))

    cap_values = [v for v, _, _ in measured]
    # First value as written, in reading order. Never the min or the max:
    # choosing between two reported values would be inference.
    capacity = cap_values[0] if cap_values else None
    capacity_reported = (measured[0][1] + " " + measured[0][2]) if measured else None
    capacity_derived = None
    if measured and re.search(r"m\s*A\s?h\s*(?:/|\s)?\s*mg", measured[0][2], re.I):
        capacity = capacity * 1000.0 if capacity is not None else None
        capacity_derived = capacity_reported
    if skipped_theoretical:
        notes.append(
            f"theoretical_value_ignored: {skipped_theoretical} capacity figure(s) "
            "in this sentence are stated as theoretical limits and were not stored "
            "as measurements")

    initial_capacity = None
    from_to = FROM_TO_RE.search(norm)
    if from_to:
        start, end = _num(from_to.group(1)), _num(from_to.group(2))
        if start is not None and end is not None and start > 0:
            initial_capacity, capacity = start, end
            capacity_reported = f"{from_to.group(1)} to {from_to.group(2)}"
    elif len(cap_values) > 1:
        notes.append(
            f"multiple_capacities_in_sentence: {len(cap_values)} values reported "
            f"({', '.join(f'{v:g}' for v in cap_values)}); this row uses the first")

    if FARAD_RE.search(norm):
        notes.append("sentence_also_reports_farads_per_gram: check for a unit mix-up")

    # Every capacity in the sentence was a theoretical limit and retention was
    # not reported either, so there is no measurement here to store.
    if capacity is None and retention is None:
        return None

    current = None
    current_reported = None
    current_derived = None
    if currents:
        raw, unit = currents[0]
        value = _num(raw)
        if value is not None:
            current_reported = f"{raw} {unit}"
            if re.match(r"^\s*A", unit, re.I):
                current = value * 1000.0          # A/g and A/kg -> mA/g
                current_derived = current_reported
            else:
                current = value

    crate = None
    crate_found = CRATE_RE.search(norm)
    if crate_found:
        crate = _num(crate_found.group(1))

    cycles = None
    cycles_found = CYCLES_RE.search(norm)
    if cycles_found:
        cycles = _num(cycles_found.group(1))

    ce = None
    for pattern in CE_RE:
        found = pattern.search(norm)
        if found:
            ce = _num(found.group(1))
            break

    voltage = None
    volt_found = VOLTAGE_RE.search(norm)
    if volt_found:
        voltage = f"{volt_found.group(1)}-{volt_found.group(2)} V"

    temperature = None
    for temp_found in TEMP_RE.finditer(norm):
        # Reject synthesis temperatures. "annealed at 800 C" is not the
        # temperature the cell was tested at, and storing it as one would be
        # wrong even though the digits are in the sentence.
        window = norm[max(0, temp_found.start() - 60):temp_found.start()]
        if SYNTHESIS_RE.search(window):
            continue
        temperature = _num(temp_found.group(1))
        break

    loading = None
    load_found = LOADING_RE.search(norm)
    if load_found:
        loading = _num(load_found.group(1))

    material, form, role, btype, electrolyte = classify(title, abstract, norm)

    return {
        "material_system": material,
        "graphene_form": form,
        "electrode_role": role,
        "battery_type": btype,
        "specific_capacity_mah_g": capacity,
        "capacity_as_reported": capacity_reported,
        "initial_capacity_mah_g": initial_capacity,
        "current_density_ma_g": current,
        "current_density_as_reported": current_reported,
        "c_rate": crate,
        "cycle_count": int(cycles) if cycles is not None else None,
        "capacity_retention_pct": retention,
        "first_cycle_ce_pct": ce,
        "voltage_window_v": voltage,
        "electrolyte": electrolyte,
        "temperature_c": temperature,
        "areal_loading_mg_cm2": loading,
        "source_quote": sentence.strip(),
        "source_section": section,
        "confidence": "pending",
        "flags": notes,
        "_derived": {k: v for k, v in (
            ("specific_capacity_mah_g", capacity_derived),
            ("current_density_ma_g", current_derived),
        ) if v},
    }


NUMERIC_FIELDS = [
    "specific_capacity_mah_g", "initial_capacity_mah_g", "current_density_ma_g",
    "c_rate", "cycle_count", "capacity_retention_pct", "first_cycle_ce_pct",
    "temperature_c", "areal_loading_mg_cm2",
]


def verify_text(row, full_text):
    """Check A. Every stored number must appear in the quote, and the quote in
    the source text. A field that fails is set to NULL and the reason logged."""
    rejections = []
    quote = row["source_quote"]
    quote_digits = normalise(quote)
    norm_full = normalise(full_text)

    if normalise(quote) not in norm_full:
        rejections.append({"field": "source_quote",
                           "reason": "quote not found in source text"})
        return rejections, False

    derived = row.get("_derived") or {}
    for field in NUMERIC_FIELDS:
        value = row.get(field)
        if value is None:
            continue
        if field in derived:
            # The stored value is a unit conversion, so the digits legitimately
            # differ from the paper. Verify the quoted source string instead.
            if normalise(derived[field]) not in quote_digits:
                rejections.append({"field": field, "reason":
                                   f"as-reported source {derived[field]!r} not in quote"})
                row[field] = None
            continue
        # The digits as written must be present. Try the integer and the
        # decimal spelling, since 500.0 is stored for a quoted "500".
        candidates = {f"{value:g}", str(value)}
        if float(value).is_integer():
            candidates.add(str(int(value)))
        if not any(c in quote_digits for c in candidates):
            rejections.append({"field": field, "reason":
                               f"value {value!r} not present in quote"})
            row[field] = None
    return rejections, True


def rows_for_paper(paper, section="abstract"):
    text = paper["abstract"] or ""
    if not text:
        return [], []
    out, rejections = [], []
    for sentence in sentences(text):
        try:
            row = extract_from_sentence(sentence, paper["title"] or "", text, section)
        except Exception as exc:                 # one sentence never stops a paper
            rejections.append({"openalex_id": paper["openalex_id"],
                               "reason": f"{type(exc).__name__}: {exc}"})
            continue
        if not row:
            continue
        rejected, quote_ok = verify_text(row, text)
        for item in rejected:
            item["openalex_id"] = paper["openalex_id"]
        rejections.extend(rejected)
        if not quote_ok:
            row["confidence"] = "unverified"
        if row["specific_capacity_mah_g"] is None and \
           row["capacity_retention_pct"] is None:
            continue                             # nothing numeric survived
        row["openalex_id"] = paper["openalex_id"]
        out.append(row)
        if len(out) >= MAX_ROWS_PER_PAPER:
            break
    return out, rejections


IDENTITY_FIELDS = [
    "openalex_id", "source_quote", "source_section", "specific_capacity_mah_g",
    "initial_capacity_mah_g", "capacity_retention_pct", "cycle_count",
    "current_density_ma_g", "c_rate", "first_cycle_ce_pct", "temperature_c",
    "areal_loading_mg_cm2", "material_system",
]


def row_hash(row) -> str:
    """Stable identity for one finding, so a re-run updates instead of adding.

    A NULL is written as a sentinel rather than left out, because SQLite's
    UNIQUE never matches two NULLs and the row would duplicate on every run.
    """
    parts = []
    for field in IDENTITY_FIELDS:
        value = row.get(field)
        parts.append("\x00" if value is None else f"{field}={value!r}")
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


INSERT_FIELDS = [
    "openalex_id", "material_system", "graphene_form", "electrode_role",
    "battery_type", "specific_capacity_mah_g", "capacity_as_reported",
    "initial_capacity_mah_g", "current_density_ma_g",
    "current_density_as_reported", "c_rate", "cycle_count",
    "capacity_retention_pct", "first_cycle_ce_pct", "voltage_window_v",
    "electrolyte", "temperature_c", "areal_loading_mg_cm2", "source_quote",
    "source_section", "confidence", "flags", "extracted_at", "row_hash",
]


def main():
    parser = argparse.ArgumentParser(description="Extract evidence rows from paper text.")
    parser.add_argument("--limit", type=int, default=None,
                        help="process only the first N papers, best-ranked first")
    parser.add_argument("--db", default=None)
    parser.add_argument("--show", type=int, default=0,
                        help="print N extracted rows beside their source quotes")
    parser.add_argument("--dry-run", action="store_true",
                        help="extract and report, write nothing")
    args = parser.parse_args()

    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn = db.init(args.db)

    sql = ("SELECT openalex_id, title, abstract FROM papers"
           " WHERE abstract IS NOT NULL AND abstract != ''"
           " AND coalesce(source,'openalex') != 'upload'"
           " ORDER BY citations_per_year DESC")
    if args.limit:
        sql += f" LIMIT {int(args.limit)}"
    papers = conn.execute(sql).fetchall()
    print(f"Papers with text to read: {len(papers)}")

    all_rows, all_rejections, failed_papers = [], [], 0
    for paper in papers:
        try:
            rows, rejections = rows_for_paper(paper)
        except Exception as exc:                 # one paper never stops the run
            failed_papers += 1
            all_rejections.append({"openalex_id": paper["openalex_id"],
                                   "reason": f"{type(exc).__name__}: {exc}"})
            continue
        all_rows.extend(rows)
        all_rejections.extend(rejections)

    print(f"Candidate evidence rows : {len(all_rows)}")
    plausibility.assess(all_rows)

    counts = {}
    for row in all_rows:
        counts[row["confidence"]] = counts.get(row["confidence"], 0) + 1
    print(f"  verified / flagged / unverified : "
          f"{counts.get('verified',0)} / {counts.get('flagged',0)} / "
          f"{counts.get('unverified',0)}")
    print(f"Fields rejected by verification   : {len(all_rejections)}")
    print(f"Papers that raised               : {failed_papers}")

    if args.show:
        print("\n--- extracted rows beside their source quotes ---")
        for row in all_rows[:args.show]:
            print(f"\n  {row['material_system']}  [{row['confidence']}]"
                  f"  {row['battery_type'] or '-'}  {row['electrode_role'] or '-'}")
            print(f"    capacity {row['specific_capacity_mah_g']} mAh/g"
                  f" | current {row['current_density_ma_g']} mA/g"
                  f" | {row['cycle_count']} cycles"
                  f" | retention {row['capacity_retention_pct']}%")
            if row["flags"]:
                print(f"    flags: {row['flags']}")
            print(f"    quote: {row['source_quote'][:300]}")

    if args.dry_run:
        print("\nDRY RUN: nothing written.")
        conn.close()
        return

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    placeholders = ",".join("?" * len(INSERT_FIELDS))
    assignments = ",".join(f"{f}=excluded.{f}" for f in INSERT_FIELDS
                           if f != "row_hash")
    sql_ins = (f"INSERT INTO evidence({','.join(INSERT_FIELDS)})"
               f" VALUES({placeholders})"
               f" ON CONFLICT(row_hash) DO UPDATE SET {assignments}")
    touched = sorted({p["openalex_id"] for p in papers})
    for start in range(0, len(touched), 400):
        batch = touched[start:start + 400]
        conn.execute(
            f"DELETE FROM evidence WHERE openalex_id IN"
            f" ({','.join('?' * len(batch))})", batch)
    conn.commit()

    written = 0
    for row in all_rows:
        row.pop("_derived", None)
        row["row_hash"] = row_hash(row)
        row["flags"] = json.dumps(row.get("flags") or [])
        row["extracted_at"] = now
        try:
            conn.execute(sql_ins, [row.get(f) for f in INSERT_FIELDS])
            written += 1
        except Exception as exc:
            all_rejections.append({"openalex_id": row["openalex_id"],
                                   "reason": f"insert failed: {exc}"})
    conn.commit()

    finished = datetime.now(timezone.utc).isoformat(timespec="seconds")
    db.log_run(conn, "extract_evidence", started, finished, written, 0,
               all_rejections[:500])
    total = conn.execute("SELECT count(*) FROM evidence").fetchone()[0]
    print(f"\nRows written            : {written}")
    print(f"Total evidence in database : {total}")
    conn.close()


if __name__ == "__main__":
    main()

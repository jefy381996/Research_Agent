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


# PubMed puts a marker where a formula, image or table stood. It is not part
# of the sentence, it is shown to whoever reads the source quote, and in one
# abstract it split "10 000 cycles" into "10[Formula: see text]000" and made
# the cycle count zero. Stripped in both places so the quote that is stored
# and the text it is verified against agree.
SOURCE_MARKER = re.compile(r"\[(?:Formula|Image|Table|Figure)\s*:\s*see\s+"
                           r"text\]", re.I)


def normalise(text: str) -> str:
    text = SOURCE_MARKER.sub(" ", text)
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
    # Before splitting, so the sentence stored as the source quote is the
    # sentence a reader sees, without the source's own markers in it.
    text = re.sub(r"\s+", " ", SOURCE_MARKER.sub(" ", text)).strip()
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
# A figure may carry thousands separators, and a pattern that cannot span one
# matches the trailing group on its own: "after 10,000 cycles" and "after
# 10 000 cycles" both captured "000" and stored a cycle count of zero. 314
# rows in the library held one, next to a real retention percentage.
GROUPED = r"\d{1,3}(?:[,\s]\d{3})+|\d{1,6}"

# An uncertainty is not a value. "617 +- 5 mAh g-1" stored 5, because 5 is
# the number nearest the unit; swallowing the "+- 5" makes 617 the
# leftmost match, so the figure read is the one the paper reported.
NUM = (r"((?:" + GROUPED + r")(?:[.,]\d+)?)"
       r"(?:\s*(?:\u00b1|\+\s*/?\s*-)\s*\d+(?:[.,]\d+)?)?")

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
    r"(" + GROUPED + r")\s*(?:charge\s*[-/]?\s*discharge\s*)?cycles", re.I)

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

# A capacity can be a setting rather than a result. "the cycle stability was
# estimated with a cutoff specific capacity of 600 mAh/g" and "up to 55 cycles
# at a limited capacity of 1000 mAh/g" are both protocol: the experimenter
# chose the number, the cell did not reach it. Read just before the figure,
# because "a limited capacity" and "delivered a capacity" differ only there.
CAPACITY_IS_A_SETTING = re.compile(
    r"\b(?:cut\s*-?\s*off|cutoff|limited|limiting|fixed|restricted|capped|"
    r"curtail\w*|controlled)\s+(?:specific\s+|reversible\s+|areal\s+)?"
    r"capacit\w*\s*(?:of|to|at)?\s*$"
    r"|\bcapacit\w*\s+(?:limited|restricted|fixed|capped)\s+(?:to|at)\s*$",
    re.I)
SETTING_LOOKBACK = 60


def _is_a_setting(before: str) -> bool:
    """True when what precedes a capacity makes it a protocol, not a result."""
    return bool(CAPACITY_IS_A_SETTING.search(before[-SETTING_LOOKBACK:]))

# What was retained, when it is not a capacity at all. An energy density's
# retention is a real measurement and a close cousin, but it is not the same
# quantity, and the table's column says capacity.
OTHER_QUANTITY = re.compile(
    r"\b(?:energy|power|areal|volumetric|gravimetric)\s+densit\w*", re.I)

# A retention percentage is a battery figure only if what was retained is a
# capacity and what it survived was charge cycling. "90.2% of its original
# capacitance after 500 bending cycles" is a flexibility test, "77.1% at 50%
# strain" is a stretching test, and a solar cell's stability is neither.
# Storing any of them as capacity retention is wrong even though the digits
# are in the sentence - the same reason a synthesis temperature is not a test
# temperature. Audited at 3 of 19 verified battery rows.
#
# The mechanical word has to BE the kind of cycling, not merely be present:
# "the lattice strain was relieved, and the electrode retained 90% after 500
# cycles" is a real result, and a window around the figure is not enough to
# tell the two apart - 40 characters of lookback threw that sentence away.
MECHANICAL_CYCLING = re.compile(
    r"\b(?:bend|bends|bending|flex|flexes|flexing|flexural|fold|folds|"
    r"folding|twist|twists|twisting|stretch|stretches|stretching|wash|"
    r"washes|washing|abrasion|rubbing|wear)\w*\s+(?:cycle|cycles|test|tests)\b"
    r"|\bafter\s+[\d,\s]+(?:bend|flex|fold|twist|stretch|wash)\w*"
    r"|\bat\s+\d+(?:\.\d+)?\s*%?\s*(?:of\s+)?strain\b"
    r"|\bat\s+(?:a\s+)?strain\s+of\s+\d"
    r"|\b(?:bending|stretching|folding|twisting)\s+(?:durability|stability)\b",
    re.I)

# A photovoltaic's stability is not a battery's, and a sentence reporting a
# power conversion efficiency is not reporting on a cell that stores charge,
# so this one is read across the whole sentence.
PHOTOVOLTAIC = re.compile(
    r"\bPCE\b|power\s+conversion\s+efficien|photovoltaic|solar\s+cell|"
    r"\bperovskite\b", re.I)

# Nor is an adsorbent's. "evaluates the CO2-adsorption relevance and cycling
# stability of graphene oxide-silica" put a gas-adsorption durability figure
# in the battery table. "Adsorption" alone is not enough - a battery paper
# mentions electrolyte adsorption - so it has to be what was cycled.
OTHER_DOMAIN = re.compile(
    r"\b(?:CO\s*2|gas|dye|methylene\s+blue|heavy\s+metal|oil)\s*-?\s*"
    r"adsorption\b|\badsorption\s+(?:capacit|cycling|stability)|"
    r"\bdye\s+(?:removal|rejection)\b|\bdesalination\b", re.I)

# What was retained. A capacitance retention is a real measurement, but it is
# not a capacity, and this is the battery table. 269 rows held one.
CAPACITANCE_RETENTION = re.compile(
    r"capacitance|supercapacit|pseudocapacit", re.I)

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
    r"theoretic|in\s+theory|maximum\s+possible"
    # A capability is a ceiling, not a result: "silicon (Si) anodes capable of
    # 3579 mAh/g" is the textbook figure for silicon, and it was the third
    # card on the measurements screen. The measurement-verb escape below still
    # rescues "capable of 3579 mAh/g, the anode delivered 1250".
    r"|capable\s+of|can\s+(?:reach|deliver|achieve|store|accommodate)"
    r"|up\s+to\s+a\s+maximum", re.I)

# Somebody else's figure, quoted for comparison. "exhibits much higher
# discharge capacity than that of the reported Mg-MOF-74 (4560 mAh/g)" was the
# second card on the measurements screen, and the number belongs to another
# group. Unlike a theoretical claim there is no escape from this one: a
# measurement verb in the sentence is this paper measuring its own material,
# not a licence to take the number beside the citation.
CREDITED_RE = re.compile(
    r"\bthe\s+reported\b|\bpreviously\s+reported\b"
    r"|\breported\s+(?:value|capacity|result)s?\b"
    r"|\bet\s+al\b|\bin\s+the\s+literature\b"
    r"|\bcompared\s+(?:to|with)\s+(?:the\s+)?reported\b", re.I)
CREDITED_LOOKBACK = 70

# A number from a calculation rather than a cell. "We propose that porous 2D
# materials ... the B7P2 monolayer is identified with an ultrahigh capacity of
# 3117 mAh/g" was the fourth card. The property extractor already flags these;
# the battery extractor did not. Flagged rather than refused, because the
# paper really did compute it and someone may want to find it.
MODELLED_RE = re.compile(
    r"\bwe\s+(?:propose|predict|calculat)|\bpredict(?:ed|s|ion)?\b"
    r"|first\s*-?\s*principles|\bDFT\b|molecular\s+dynamic|\bsimulat"
    r"|\bmonolayer\s+is\s+identified|calculations\s+(?:show|reveal|predict)",
    re.I)

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

def _case_strict(vocab):
    """Chemical symbols and abbreviations are case-sensitive; words are not.

    Matched case-insensitively, "\\bGO\\b" matches the verb "go" - so "we then
    go on to measure the sample" was labelled graphene oxide. In twelve
    hundred characters of abstract that is rare; in forty thousand characters
    of body it fires constantly. "\\bSe\\b" matched "SE", shielding
    effectiveness, and filed a silver-nanowire film as a selenium composite.

    Any pattern carrying an uppercase letter is a formula or an initialism and
    must match exactly. The spelled-out words stay case-insensitive, because a
    title capitalises them.
    """
    return [(label, tuple(f"(?-i:{p})" if any(c.isupper() for c in p) else p
                          for p in patterns))
            for label, patterns in vocab]


GRAPHENE_FORMS = _case_strict(GRAPHENE_FORMS)
PARTNERS = _case_strict(PARTNERS)
BATTERY_TYPES = _case_strict(BATTERY_TYPES)

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
    """A matched figure as a number, separators and all.

    Stripping the space as well as the comma, because papers write "10 000"
    as often as "10,000" and float() takes neither.
    """
    try:
        return float(str(raw).replace(",", "").replace(" ", "")
                     .replace("\u00a0", "").replace("\u202f", ""))
    except (TypeError, ValueError):
        return None


def _corroborated(vocab, title, abstract):
    """A label taken from the paper rather than the sentence, if the paper
    means it.

    A name in the title is the paper's subject. A name mentioned once
    somewhere in an abstract is as often the counter-electrode or a line of
    background: "In Zn||MnO2 full batteries" labelled a zinc-graphene anode
    as MnO2, "with a Cu2Se anode" labelled an NVPF cathode as Se, and "hard
    carbon (HC) as anodes" labelled a Ni/Mn cathode as hard carbon. Judged by
    hand, that slice ran about a third wrong, and in every wrong case the name
    appeared once while every multiply-named one was right.

    So a name found only in the abstract has to be said twice. The row then
    keeps the less specific label it can support - the graphene form alone -
    which is worth more to somebody filtering by material than a precise
    label that is false.
    """
    found = _first_match(vocab, normalise(title or ""))
    if found:
        return found
    body = normalise(abstract or "")
    found = _first_match(vocab, body)
    if not found:
        return None
    for label, patterns in vocab:
        if label != found:
            continue
        hits = sum(len(re.findall(pattern, body, re.I)) for pattern in patterns)
        return found if hits >= 2 else None
    return None


def classify(title, abstract, sentence):
    """Categorical labels. The sentence wins; the paper is the fallback, and
    has to mean it - see _corroborated."""
    paper_text = normalise(f"{title} {abstract}")
    form = (_first_match(GRAPHENE_FORMS, sentence)
            or _corroborated(GRAPHENE_FORMS, title, abstract))
    btype = _first_match(BATTERY_TYPES, sentence) or _first_match(BATTERY_TYPES, paper_text)
    role = _first_match(ELECTRODE_ROLES, sentence) or _first_match(ELECTRODE_ROLES, paper_text)
    partner = (_first_match(PARTNERS, sentence)
               or _corroborated(PARTNERS, title, abstract))

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

    caps = [m.groups() for m in CAPACITY_RE.finditer(work)
            if not _is_a_setting(work[:m.start()])]
    for match in CAPACITY_RE.finditer(norm):          # blank out so mA/g does not
        work = work.replace(match.group(0), " " * len(match.group(0)), 1)

    currents = CURRENT_RE.findall(work)

    retention = None
    not_cycling = False
    for pattern in RETENTION_RE:
        found = pattern.search(norm)
        if found:
            if (MECHANICAL_CYCLING.search(norm) or PHOTOVOLTAIC.search(norm)
                    or OTHER_DOMAIN.search(norm)):
                # Mechanical durability, or a photovoltaic's stability. The
                # cycle count goes with it: "500 bending cycles" is not 500
                # charge cycles. A capacity in the same sentence still stands.
                not_cycling = True
                break
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
    skipped_setting = 0
    skipped_credited = 0
    for match in CAPACITY_RE.finditer(norm):
        value = _num(match.group(1))
        if value is None:
            continue
        before = norm[:match.start()]
        claim = THEORETICAL_RE.search(before)
        if claim and not MEASURED_RE.search(before[claim.end():]):
            skipped_theoretical += 1
            continue
        if _is_a_setting(before):
            # A cutoff or limited capacity is the number the experimenter
            # chose, not the one the cell reached.
            skipped_setting += 1
            continue
        if CREDITED_RE.search(before[-CREDITED_LOOKBACK:]):
            skipped_credited += 1
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

    if (retention is not None and not caps
            and OTHER_QUANTITY.search(norm)
            and not re.search(r"capacit(?:y|ies)\s+retention", norm, re.I)):
        notes.append("retention_of_another_quantity: what was retained is a "
                     "density, not a capacity")

    if MODELLED_RE.search(norm):
        notes.append("modelled_not_measured: the figure comes from a "
                     "calculation or a prediction, not a cell")

    if retention is not None and not caps and CAPACITANCE_RETENTION.search(norm):
        # Flagged rather than refused: the percentage and the cycle count are
        # a real electrochemical measurement, they are just not a capacity's.
        # Flagged keeps it searchable with its sentence while the answer path,
        # which serves verified rows only, leaves it out of battery answers.
        notes.append("capacitance_not_capacity: what was retained is a "
                     "capacitance, so this is not a battery capacity retention")

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
    if cycles_found and not not_cycling:
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


def rows_for_paper(paper, section="abstract", cap=None):
    """Findings from one paper's text.

    `cap` limits the rows one paper may contribute. An abstract states a
    handful of results, so the default is deliberately small; a full paper
    reports many, and the caller raises it.
    """
    cap = MAX_ROWS_PER_PAPER if cap is None else cap
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
        if len(out) >= cap:
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
        # Scoped to the section this run writes. Unscoped, a re-run over the
        # abstracts deleted every row the full-text pass had written for the
        # same papers - 440 of them, silently, because both readings live in
        # one table and only the section tells them apart.
        conn.execute(
            f"DELETE FROM evidence WHERE openalex_id IN"
            f" ({','.join('?' * len(batch))})"
            f" AND coalesce(source_section,'abstract')='abstract'", batch)
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

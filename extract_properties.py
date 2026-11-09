#!/usr/bin/env python3
"""Pull the non-battery numbers out of the same abstracts.

Same contract as the battery extractor, deliberately: one row is scoped to one
sentence, every number in it was read from that sentence, and the sentence is
stored beside the number so a reader can check it. Nothing is inferred.

What differs is the ambiguity. "372 mAh/g" can only be a capacity. "5 GPa" is a
modulus or a strength depending on the words around it, and "97%" is a
transmittance only if the sentence says so. Families carrying an unambiguous
unit are matched on the unit alone; the rest must name the property in the same
sentence, and the figure taken is the one nearest that mention. A sentence that
names two such properties is skipped rather than guessed at.

Re-running is safe: identity is a hash of the content, so a second pass updates
rows instead of adding them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone

import db
import properties as P
from extract_evidence import (GRAPHENE_FORMS, PARTNERS, _first_match,
                              normalise, sentences)

APPLICATIONS = [
    ("thermal management", (r"thermal\s+management", r"heat\s+dissipat",
                            r"heat\s+spread", r"thermal\s+interface")),
    ("transparent electrode", (r"transparent\s+(?:conduct|electrode)",
                               r"touch\s+screen", r"flexible\s+electrode")),
    ("membrane", (r"\bmembrane", r"desalination", r"nanofiltration",
                  r"water\s+treatment", r"\bfiltration\b")),
    ("sensor", (r"\bsensor\b", r"\bsensing\b", r"\bbiosensor", r"\bdetection\s+of")),
    ("supercapacitor", (r"supercapacitor", r"electrochemical\s+capacitor",
                        r"\bEDLC\b", r"pseudocapacit")),
    ("EMI shielding", (r"shielding\s+effectiveness", r"electromagnetic\s+"
                       r"interference", r"\bEMI\b", r"microwave\s+absorp")),
    ("composite", (r"\bcomposite", r"\bnanocomposite", r"\bpolymer\s+matrix",
                   r"\bepoxy\b", r"\bPDMS\b", r"\bPVA\b")),
    ("transistor", (r"transistor", r"\bFET\b", r"\bGFET\b", r"logic\s+device")),
    ("catalysis", (r"\bcatalys", r"\bORR\b", r"\bHER\b", r"\bOER\b")),
    ("coating", (r"\bcoating", r"anti\s*-?\s*corrosion", r"\bbarrier\s+film")),
    ("energy storage", (r"\bbatter", r"\banode\b", r"\bcathode\b")),
    ("biomedical", (r"\bdrug\s+deliver", r"\btissue\b", r"\bantibacterial",
                    r"\bbiomedical", r"\bcytotox")),
]

MAX_ROWS_PER_PAPER = 8

IDENTITY_FIELDS = ["openalex_id", "property_key", "value", "unit", "source_quote"]
INSERT_FIELDS = [
    "openalex_id", "property_key", "property_label", "value", "unit",
    "value_as_reported", "material", "graphene_form", "application",
    "source_quote", "source_section", "confidence", "flags", "extracted_at",
    "row_hash",
]

# Compiled once: (family, compiled pattern, scale)
_COMPILED = [
    (fam, re.compile(pat, re.I), scale)
    for fam in P.FAMILIES
    for pat, scale in fam["patterns"]
    if scale is not None            # a None scale marks a unit we do not store
]
_ALIAS_RE = {
    fam["key"]: re.compile("|".join(re.escape(a) for a in fam["aliases"]), re.I)
    for fam in P.FAMILIES
}

# A percentage is a transmittance only next to the word; these are the phrases
# that most often sit beside a stray percentage in a graphene abstract.
_PCT_DECOYS = re.compile(
    r"retention|efficiency|yield|purity|loading|content|increase[d]?\s+by|"
    r"improv\w*\s+by|enhanc\w*\s+by|reduc\w*\s+by|removal|degradation|"
    r"humidity|absorb|absorpt|reflect|rejection|\bRH\b",
    re.I)


def _flags_for(fam: dict, value: float, sentence: str) -> list[str]:
    out = []
    if value < fam["low"] or value > fam["high"]:
        out.append(f"{fam['key']}_out_of_range")
    if fam["key"] == "surface_area" and value > 2630:
        # 2630 m2/g is the area of a perfect single sheet counted both sides.
        out.append("above_single_layer_theoretical_2630")
    if fam["key"] == "thermal_conductivity" and value > 5300:
        out.append("above_suspended_single_layer_~5300")
    if fam["key"] == "transmittance" and value > 100:
        out.append("transmittance_above_100pct")
    return out


_MODELLED = re.compile(
    r"theoretic|predict|simulat|first\s*-?\s*principles|\bDFT\b|"
    r"molecular\s+dynamic", re.I)


def _modelled_near(sentence: str, span: tuple[int, int]) -> bool:
    """A modelling word anywhere in a long sentence said little; one beside the
    figure says the figure came from a model rather than an instrument."""
    start, end = span
    window = sentence[max(0, start - 90):end + 90]
    return bool(_MODELLED.search(window))


def _nearest(matches, alias_span):
    """The figure closest to where the property was named."""
    centre = (alias_span[0] + alias_span[1]) / 2
    return min(matches, key=lambda m: abs((m.start() + m.end()) / 2 - centre))


def rows_for_sentence(sentence: str, title: str, abstract: str,
                      section: str = "abstract") -> list[dict]:
    """Every property this one sentence states, or an empty list."""
    work = normalise(sentence)
    found: list[dict] = []
    seen_keys: set[str] = set()

    # A sentence that names two properties sharing a unit cannot have a figure
    # assigned to either: "a modulus of 1 TPa and a strength of 130 GPa" needs
    # to know which GPa belongs to which. Families with a unit of their own are
    # unaffected, so one sentence can still yield a strength and a conductivity.
    named = [f for f in P.FAMILIES if f.get("needs_alias")
             and _ALIAS_RE[f["key"]].search(work)]
    contested = {f["shares_unit_with"] for f in named
                 if f.get("shares_unit_with")
                 and sum(1 for g in named
                         if g.get("shares_unit_with") == f["shares_unit_with"]) > 1}

    for fam, rx, scale in _COMPILED:
        if fam["key"] in seen_keys:
            continue
        alias = _ALIAS_RE[fam["key"]].search(work)
        if fam.get("needs_alias"):
            if not alias or fam.get("shares_unit_with") in contested:
                continue
            if fam["key"] == "transmittance" and _PCT_DECOYS.search(work):
                continue
        matches = list(rx.finditer(work))
        if not matches:
            continue
        match = _nearest(matches, alias.span()) if alias else matches[0]
        value = P._n(match.group(1))
        if value is None:
            continue
        value *= scale
        flags = _flags_for(fam, value, work)
        if _modelled_near(work, match.span()):
            flags.append("modelled_not_measured")
        found.append({
            "property_key": fam["key"],
            "property_label": fam["label"],
            "value": round(value, 6),
            "unit": fam["unit"],
            "value_as_reported": match.group(0).strip(),
            "flags": flags,
        })
        seen_keys.add(fam["key"])

    if not found:
        return []

    paper_text = normalise(f"{title} {abstract}")
    form = (_first_match(GRAPHENE_FORMS, work)
            or _first_match(GRAPHENE_FORMS, paper_text))
    partner = _first_match(PARTNERS, work) or _first_match(PARTNERS, paper_text)
    application = (_first_match(APPLICATIONS, work)
                   or _first_match(APPLICATIONS, paper_text))
    material = f"{partner}/{form}" if partner and form else (form or partner)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = []
    for item in found:
        flags = item.pop("flags")
        rows.append({
            **item,
            "material": material,
            "graphene_form": form,
            "application": application,
            "source_quote": sentence.strip(),
            "source_section": section,
            "confidence": "flagged" if flags else "verified",
            "flags": ";".join(flags) if flags else None,
            "extracted_at": now,
        })
    return rows


def verify_text(row: dict) -> bool:
    """The figure must be readable in the sentence exactly as it was reported."""
    quote = normalise(row["source_quote"])
    return normalise(row["value_as_reported"]).lower() in quote.lower()


def row_hash(row: dict) -> str:
    parts = []
    for field in IDENTITY_FIELDS:
        value = row.get(field)
        parts.append("\x00" if value is None else f"{field}={value!r}")
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def rows_for_paper(paper: dict) -> list[dict]:
    text = paper.get("abstract") or ""
    out: list[dict] = []
    for sentence in sentences(text):
        for row in rows_for_sentence(sentence, paper.get("title") or "", text):
            row["openalex_id"] = paper["openalex_id"]
            if not verify_text(row):
                continue
            row["row_hash"] = row_hash(row)
            out.append(row)
            if len(out) >= MAX_ROWS_PER_PAPER:
                return out
    return out


def main():
    parser = argparse.ArgumentParser(
        description="Extract material-property rows from paper abstracts.")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--db", default=None)
    args = parser.parse_args()

    conn = db.init(args.db)
    conn.row_factory = sqlite3.Row
    query = ("SELECT openalex_id, title, abstract FROM papers "
             "WHERE abstract IS NOT NULL AND length(abstract) > 120")
    if args.limit:
        query += f" LIMIT {int(args.limit)}"

    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    papers = conn.execute(query).fetchall()
    added = failed = 0
    placeholders = ",".join("?" * len(INSERT_FIELDS))
    columns = ",".join(INSERT_FIELDS)

    for paper in papers:
        try:
            rows = rows_for_paper(dict(paper))
        except Exception:
            # One malformed abstract must never stop the run.
            failed += 1
            continue
        for row in rows:
            try:
                conn.execute(
                    f"INSERT INTO properties({columns}) VALUES({placeholders}) "
                    f"ON CONFLICT(row_hash) DO UPDATE SET "
                    f"confidence=excluded.confidence, flags=excluded.flags, "
                    f"extracted_at=excluded.extracted_at",
                    [row.get(f) for f in INSERT_FIELDS])
                added += 1
            except Exception:
                failed += 1
        conn.commit()

    total = conn.execute("SELECT count(*) FROM properties").fetchone()[0]
    by_key = conn.execute(
        "SELECT property_key, count(*), sum(confidence='verified') "
        "FROM properties GROUP BY property_key ORDER BY 2 DESC").fetchall()
    conn.execute(
        "INSERT INTO run_log(run_type, started_at, finished_at, records_added,"
        " records_updated, errors_json) VALUES(?,?,?,?,?,?)",
        ("extract_properties", started,
         datetime.now(timezone.utc).isoformat(timespec="seconds"),
         added, total,
         json.dumps({"failures": failed, "rows_in_table": total})))
    conn.commit()

    print(f"papers read      {len(papers)}")
    print(f"rows written     {added}  (failures {failed})")
    print(f"rows in table    {total}")
    for key, count, verified in by_key:
        print(f"  {key:26} {count:5}  verified {verified}")
    conn.close()


if __name__ == "__main__":
    main()

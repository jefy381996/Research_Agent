#!/usr/bin/env python3
"""Build the static mirror in demo/ from the database.

The mirror is the same interface and the same data as the live service, with
the evidence table and the stored abstracts embedded so the page needs no
backend. It is for sharing a working link without deploying anything. PDF
upload is the one feature it cannot offer, because that needs the service.

Run after the pipeline, then serve the folder:
    python build_demo.py
    python -m http.server 8001 --directory demo
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter

import calculators
import db

EVIDENCE_SQL = """
SELECT e.id, e.openalex_id, e.material_system, e.graphene_form, e.electrode_role,
       e.battery_type, e.specific_capacity_mah_g, e.capacity_as_reported,
       e.initial_capacity_mah_g, e.current_density_ma_g,
       e.current_density_as_reported, e.c_rate, e.cycle_count,
       e.capacity_retention_pct, e.first_cycle_ce_pct, e.voltage_window_v,
       e.electrolyte, e.temperature_c, e.areal_loading_mg_cm2, e.confidence,
       e.flags, e.source_quote, e.source_section,
       p.title, p.year, p.journal, p.doi
FROM evidence e JOIN papers p ON p.openalex_id = e.openalex_id
"""

ABSTRACT_LIMIT = 1200
MAX_PASSAGES = 6000     # most-cited first; the browser bundle stays under ~10 MB


def main():
    parser = argparse.ArgumentParser(description="Build the static mirror.")
    parser.add_argument("--db", default=None)
    parser.add_argument("--out", default="web/data.json")
    parser.add_argument("--max-passages", type=int, default=MAX_PASSAGES)
    parser.add_argument("--passage-chars", type=int, default=ABSTRACT_LIMIT)
    args = parser.parse_args()

    conn = db.connect(args.db)
    rows = []
    for record in conn.execute(EVIDENCE_SQL):
        row = dict(record)
        row["flags"] = json.loads(row["flags"] or "[]")
        rows.append(row)
    if not rows:
        raise SystemExit("The evidence table is empty. Run the pipeline first.")

    def facet(column):
        counts = Counter(r[column] for r in rows if r[column])
        return [{"value": k, "count": v} for k, v in counts.most_common(40)]

    # Every paper that produced a measurement is kept, then the most-cited of
    # the rest fill the budget, so nothing cited by an answer is ever missing.
    cited = {r["openalex_id"] for r in rows}
    passages, seen = [], set()
    for record in conn.execute(
            "SELECT openalex_id, title, year, journal, doi, abstract FROM papers"
            " WHERE abstract IS NOT NULL AND abstract != ''"
            " ORDER BY citations_per_year DESC"):
        wid = record["openalex_id"]
        if wid in seen:
            continue
        if len(passages) >= args.max_passages and wid not in cited:
            continue
        seen.add(wid)
        passages.append({"i": wid, "t": record["title"], "y": record["year"],
                         "j": record["journal"], "d": record["doi"],
                         "x": record["abstract"][:args.passage_chars]})

    one = lambda sql: conn.execute(sql).fetchone()[0]
    concepts = [dict(r) for r in conn.execute(
        "SELECT slug, title, category, summary, description, url, source, licence"
        " FROM concepts ORDER BY category, title")]
    compounds = [dict(r) for r in conn.execute(
        "SELECT cid, name, formula, molecular_weight, smiles, iupac_name, url"
        " FROM compounds ORDER BY name")]

    payload = {
        "rows": rows,
        "passages": passages,
        "concepts": concepts,
        "compounds": compounds,
        "calculators": calculators.catalogue(),
        "facets": {k: facet(k) for k in ("confidence", "battery_type",
                                         "graphene_form", "electrode_role",
                                         "material_system")},
        "stats": {
            "papers": one("SELECT count(*) FROM papers"),
            "papers_with_text": one("SELECT count(*) FROM paper_sections"),
            "papers_reusable": one(
                "SELECT count(*) FROM papers WHERE full_text_reusable='yes'"),
            "evidence_rows": len(rows),
            "verified": sum(1 for r in rows if r["confidence"] == "verified"),
            "flagged": sum(1 for r in rows if r["confidence"] == "flagged"),
            "material_systems": len({r["material_system"] for r in rows
                                     if r["material_system"]}),
            "year_range": list(conn.execute(
                "SELECT min(year), max(year) FROM papers WHERE year IS NOT NULL"
            ).fetchone()),
            "concepts": one("SELECT count(*) FROM concepts"),
            "compounds": one("SELECT count(*) FROM compounds"),
            "calculators": len(calculators.REGISTRY),
            "checks": {
                "capacity_hard_max_mah_g": 5000, "cycle_hard_max": 100000,
                "temperature_range_c": [-40, 200], "voltage_range_v": [0, 5],
                "outlier_sigma": 3.5,
            },
        },
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"), ensure_ascii=False)
    size = os.path.getsize(args.out) / 1_048_576
    print(f"Evidence rows embedded : {len(rows)}")
    print(f"Abstracts embedded     : {len(passages)}")
    print(f"Concepts embedded      : {len(concepts)}")
    print(f"Compounds embedded     : {len(compounds)}")
    print(f"Calculators embedded   : {len(payload['calculators'])}")
    print(f"Written                : {args.out} ({size:.2f} MB)")
    conn.close()


if __name__ == "__main__":
    main()

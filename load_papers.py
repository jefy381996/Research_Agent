#!/usr/bin/env python3
"""Load data/papers.csv into the papers table.

Matches on the OpenAlex work id, updates rows that already exist, and maps an
empty DOI to NULL so the UNIQUE constraint behaves. Safe to re-run.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime, timezone

import db

FIELDS = [
    "openalex_id", "doi", "title", "year", "publication_date", "journal",
    "publisher", "authors", "cited_by_count", "citations_per_year", "abstract",
    "oa_status", "licence", "full_text_reusable", "pdf_url", "landing_url",
    "source", "source_queries", "is_preprint", "fetched_at",
]


def to_row(csv_row):
    def num(key, cast, default=0):
        try:
            return cast(csv_row.get(key) or default)
        except (TypeError, ValueError):
            return default

    return {
        "openalex_id": (csv_row.get("openalex_id") or "").strip(),
        "doi": (csv_row.get("doi") or "").strip() or None,
        "title": (csv_row.get("title") or "").strip(),
        "year": num("year", int, 0) or None,
        "publication_date": csv_row.get("publication_date") or None,
        "journal": csv_row.get("journal") or None,
        "publisher": csv_row.get("publisher") or None,
        "authors": json.dumps(
            [a.strip() for a in (csv_row.get("authors") or "").split(";") if a.strip()]),
        "cited_by_count": num("cited_by_count", int),
        "citations_per_year": num("citations_per_year", float, 0.0),
        "abstract": csv_row.get("abstract") or None,
        "oa_status": csv_row.get("oa_status") or None,
        "licence": csv_row.get("licence") or None,
        "full_text_reusable": csv_row.get("full_text_reusable") or None,
        "pdf_url": csv_row.get("pdf_url") or None,
        "landing_url": csv_row.get("landing_page_url") or None,
        "source": "openalex",
        "source_queries": csv_row.get("source_queries") or None,
        "is_preprint": csv_row.get("is_preprint") or "no",
        "fetched_at": csv_row.get("retrieved_at") or None,
    }


def main():
    parser = argparse.ArgumentParser(description="Load papers.csv into the database.")
    parser.add_argument("--csv", default="data/papers.csv")
    parser.add_argument("--db", default=None)
    args = parser.parse_args()

    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn = db.init(args.db)

    existing = {r["openalex_id"] for r in conn.execute("SELECT openalex_id FROM papers")}
    inserted = updated = skipped = 0
    errors = []

    placeholders = ",".join("?" * len(FIELDS))
    assignments = ",".join(f"{f}=excluded.{f}" for f in FIELDS if f != "openalex_id")
    sql = (f"INSERT INTO papers({','.join(FIELDS)}) VALUES({placeholders})"
           f" ON CONFLICT(openalex_id) DO UPDATE SET {assignments}")

    try:
        handle = open(args.csv, newline="", encoding="utf-8")
    except OSError as exc:
        sys.exit(f"ERROR: cannot read {args.csv}: {exc}")

    with handle:
        for line_no, csv_row in enumerate(csv.DictReader(handle), start=2):
            try:
                row = to_row(csv_row)
                if not row["openalex_id"] or not row["title"]:
                    skipped += 1
                    errors.append({"line": line_no, "reason": "missing id or title"})
                    continue
                conn.execute(sql, [row[f] for f in FIELDS])
                if row["openalex_id"] in existing:
                    updated += 1
                else:
                    inserted += 1
                    existing.add(row["openalex_id"])
            except Exception as exc:      # one bad row never stops the load
                skipped += 1
                errors.append({"line": line_no, "reason": f"{type(exc).__name__}: {exc}"})

    conn.commit()
    finished = datetime.now(timezone.utc).isoformat(timespec="seconds")
    db.log_run(conn, "load_papers", started, finished, inserted, updated, errors)

    total = conn.execute("SELECT count(*) FROM papers").fetchone()[0]
    with_abstract = conn.execute(
        "SELECT count(*) FROM papers WHERE abstract IS NOT NULL AND abstract != ''"
    ).fetchone()[0]
    print(f"Inserted : {inserted}")
    print(f"Updated  : {updated}")
    print(f"Skipped  : {skipped}")
    if errors[:5]:
        for e in errors[:5]:
            print(f"  line {e['line']}: {e['reason']}")
    print(f"Total papers in database : {total}")
    print(f"  with an abstract       : {with_abstract}")
    conn.close()


if __name__ == "__main__":
    main()

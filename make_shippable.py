#!/usr/bin/env python3
"""Get the database under the size a git host will take, losing as little as
possible.

Two things are dropped, in this order.

`chunks` and `paper_sections` are a second and third copy of every abstract.
They rebuild from the abstracts in seconds and the service does that on first
boot, so they go first and cost nothing.

Abstracts are the remainder, and at a hundred thousand papers they are most of
the file. They cannot all be kept, so they are kept in order of what they are
for: every paper a measurement was read from, because a figure without its
sentence is exactly what this tool refuses to publish; then the most-cited of
the rest, until the budget runs out. A paper whose abstract is dropped keeps
its title, journal, year and DOI, stays searchable by those, and still links to
the published original - it simply stops contributing passages.

The budget is a target for the finished file, not for the abstracts alone;
indexes and page overhead are measured rather than assumed.
"""
import argparse
import os
import sqlite3

import db

DEFAULT_BUDGET_MB = 88          # GitHub refuses above 100; leave room to grow


def size_mb(path):
    return os.path.getsize(path) / 1048576


def vacuum(path):
    plain = sqlite3.connect(path)
    plain.execute("VACUUM")
    plain.close()


def main():
    ap = argparse.ArgumentParser(description="Shrink the database for shipping.")
    ap.add_argument("path", nargs="?", default=db.DB_PATH)
    ap.add_argument("--budget-mb", type=float, default=DEFAULT_BUDGET_MB,
                    help="target size of the finished file")
    args = ap.parse_args()
    path, budget = args.path, args.budget_mb

    before = size_mb(path)
    conn = db.connect(path)
    try:
        kept = {t: conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
                for t in ("papers", "evidence", "properties", "concepts",
                          "compounds", "agent_cache")}
        conn.execute("DELETE FROM chunks")
        conn.execute("DELETE FROM paper_sections")
        conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")
        conn.commit()
    finally:
        conn.close()
    vacuum(path)
    after_derived = size_mb(path)

    # Abstracts, if the file is still too big.
    dropped = 0
    conn = db.connect(path)
    try:
        if size_mb(path) > budget:
            # Never these: a measurement has to keep the sentence it came from.
            conn.execute("""
                CREATE TEMP TABLE must_keep AS
                SELECT openalex_id FROM evidence
                UNION SELECT openalex_id FROM properties""")
            protected = conn.execute("SELECT count(*) FROM must_keep").fetchone()[0]

            have = conn.execute(
                "SELECT count(*) FROM papers WHERE abstract IS NOT NULL"
                " AND abstract != ''").fetchone()[0]
            over = size_mb(path) - budget
            per_abstract = (conn.execute(
                "SELECT coalesce(avg(length(abstract)), 0) FROM papers"
                " WHERE abstract IS NOT NULL AND abstract != ''"
            ).fetchone()[0] or 1) / 1048576
            # Dropping text frees roughly its own size once vacuumed.
            to_drop = min(max(0, int(over / max(per_abstract, 1e-9)) + 500),
                          max(0, have - protected))

            if to_drop:
                conn.execute("""
                    UPDATE papers SET abstract = ''
                    WHERE openalex_id IN (
                      SELECT p.openalex_id FROM papers p
                      WHERE p.abstract IS NOT NULL AND p.abstract != ''
                        AND p.openalex_id NOT IN (SELECT openalex_id FROM must_keep)
                      ORDER BY coalesce(p.cited_by_count, 0) ASC,
                               coalesce(p.year, 0) ASC
                      LIMIT ?)""", (to_drop,))
                conn.commit()
                dropped = conn.total_changes
            print(f"  abstracts: {have} present, {protected} protected by a "
                  f"measurement, {dropped} of the least-cited dropped")
    finally:
        conn.close()
    if dropped:
        vacuum(path)

    conn = db.connect(path)
    try:
        left = conn.execute(
            "SELECT count(*) FROM papers WHERE abstract IS NOT NULL"
            " AND abstract != ''").fetchone()[0]
    finally:
        conn.close()

    after = size_mb(path)
    print(f"{path}: {before:.0f} MB -> {after_derived:.0f} MB (derived tables) "
          f"-> {after:.0f} MB")
    for name, count in kept.items():
        print(f"  kept {name:12} {count}")
    print(f"  abstracts kept {left}")
    print("  dropped chunks and paper_sections; the service rebuilds them on boot")
    if after > 100:
        raise SystemExit(f"ERROR: still {after:.0f} MB, over the 100 MB a git "
                         f"host accepts. Lower --budget-mb and run again.")


if __name__ == "__main__":
    main()

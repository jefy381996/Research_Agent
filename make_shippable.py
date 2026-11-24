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

# The file that ships is no longer this one. pack_db.py compresses it about
# five times over and db.ensure_database unpacks it on first use, so the
# hundred megabytes a git host allows now carries roughly five hundred of
# library. Dropping abstracts to fit was costing 30,058 of the 45,148 the
# collection holds - two thirds of the searchable text, and every
# measurement that could have been read out of them.
#
# This budget is now only a guard against a file too unwieldy to work with.
# pack_db is the gatekeeper: it refuses to write an archive over the limit
# and says to publish a release asset instead.
DEFAULT_BUDGET_MB = 400          # GitHub refuses above 100; leave room to grow


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
        # Which papers the full-text pass has read. Working state for a
        # collection that runs outside the library, of no use to anyone who
        # downloads it.
        conn.execute("DROP TABLE IF EXISTS fulltext_seen")
        conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")
        conn.commit()
    finally:
        conn.close()
    vacuum(path)
    after_derived = size_mb(path)

    # Abstracts, if the file is still too big.
    #
    # One pass of this used to guess how many to drop from the average length,
    # on the assumption that dropping text frees its own size. It frees more
    # than that - the page and index overhead goes with it - so the guess
    # overshot: asked for 88 MB it produced 72, having thrown away about
    # thirteen thousand abstracts it did not need to. Abstracts are what the
    # engine reads to answer anything the measurements do not cover, so that
    # is coverage given away for nothing.
    #
    # Dropping cannot be undone within a run, so each round now takes a
    # deliberate fraction of what it thinks is needed, vacuums, and measures
    # the real file again. It converges from above and stops as soon as it is
    # inside the budget, keeping as many abstracts as the budget allows.
    TIMID = 0.6                 # take this much of the estimate, then look
    MAX_ROUNDS = 12
    DROPPABLE = """
        SELECT p.openalex_id FROM papers p
        WHERE p.abstract IS NOT NULL AND p.abstract != ''
          AND p.openalex_id NOT IN (SELECT openalex_id FROM evidence)
          AND p.openalex_id NOT IN (SELECT openalex_id FROM properties)
        ORDER BY coalesce(p.cited_by_count, 0) ASC,
                 coalesce(p.year, 0) ASC
        LIMIT ?"""

    conn = db.connect(path)
    try:
        had = conn.execute("SELECT count(*) FROM papers WHERE abstract IS NOT NULL"
                           " AND abstract != ''").fetchone()[0]
        protected = conn.execute(
            "SELECT count(*) FROM (SELECT openalex_id FROM evidence"
            " UNION SELECT openalex_id FROM properties) m"
            " JOIN papers p ON p.openalex_id = m.openalex_id"
            " WHERE p.abstract IS NOT NULL AND p.abstract != ''").fetchone()[0]
    finally:
        conn.close()

    dropped, rounds = 0, 0
    while size_mb(path) > budget and rounds < MAX_ROUNDS:
        rounds += 1
        conn = db.connect(path)
        try:
            left = conn.execute(
                "SELECT count(*) FROM papers p WHERE p.abstract IS NOT NULL"
                " AND p.abstract != ''"
                " AND p.openalex_id NOT IN (SELECT openalex_id FROM evidence)"
                " AND p.openalex_id NOT IN (SELECT openalex_id FROM properties)"
            ).fetchone()[0]
            if not left:
                break
            per_abstract = (conn.execute(
                "SELECT coalesce(avg(length(abstract)), 0) FROM papers"
                " WHERE abstract IS NOT NULL AND abstract != ''"
            ).fetchone()[0] or 1) / 1048576
            over = size_mb(path) - budget
            want = int(over / max(per_abstract, 1e-9) * TIMID) + 200
            take = min(want, left)
            before_changes = conn.total_changes
            conn.execute(f"UPDATE papers SET abstract = ''"
                         f" WHERE openalex_id IN ({DROPPABLE})", (take,))
            conn.commit()
            dropped += conn.total_changes - before_changes
        finally:
            conn.close()
        vacuum(path)

    if had:
        print(f"  abstracts: {had} present, {protected} protected by a "
              f"measurement, {dropped} of the least-cited dropped"
              + (f" over {rounds} rounds" if rounds else ""))

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
    # This file is not the one that ships any more. pack_db.py compresses it
    # about five times and refuses to write an archive a git host would
    # reject, so it is the gatekeeper and this is only a signpost.
    print(f"  {after:.0f} MB of library, which packs to roughly"
          f" {after / 5.2:.0f} MB. Run pack_db.py next.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Strip the derived tables so the database fits a git host.

`chunks` and `paper_sections` are a second and third copy of every abstract.
Keeping them trebles the file, pushing it past the 100 MB a git host accepts.
They rebuild from the abstracts in a few seconds, and the service does that on
first boot, so they are removed before committing.
"""
import os
import sqlite3
import sys

import db


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else db.DB_PATH
    before = os.path.getsize(path) / 1048576
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
    plain = sqlite3.connect(path)
    plain.execute("VACUUM")
    plain.close()
    after = os.path.getsize(path) / 1048576
    print(f"{path}: {before:.0f} MB -> {after:.0f} MB")
    for name, count in kept.items():
        print(f"  kept {name:12} {count}")
    print("  dropped chunks and paper_sections; the service rebuilds them on boot")


if __name__ == "__main__":
    main()

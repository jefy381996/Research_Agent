#!/usr/bin/env python3
"""Create the database and every table, idempotently. Safe to re-run."""

import sys

import db


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else None
    conn = db.init(path)
    tables = [r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
        " AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    print(f"Database ready: {path or db.DB_PATH}")
    for name in tables:
        count = conn.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
        print(f"  {name:22} {count:>8} rows")
    conn.close()


if __name__ == "__main__":
    main()

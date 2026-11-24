#!/usr/bin/env python3
"""Draw a sample of the library and record how much of it is right.

Every research tool claims to be accurate. None of them says how accurate, or
how they know. This is how this one knows: rows are drawn at random, read one
at a time against the sentence stored beside them, and the verdict is written
down with the date, the sample size and who judged it. The app then shows that
figure on the screen rather than a claim.

The number that matters is not the one in a sales deck but the one a reader
can reproduce: `python3 audit_accuracy.py --draw 20 --population battery`
gives a numbered sample, and `--record` writes the result. Drawing is random
with a seed, so an auditor can hand the seed to somebody else and get the same
twenty rows.

A single honest figure with a sample size beside it is worth more than a
confident one with nothing behind it, which is why the sample size and the
date are shown wherever the figure is.
"""

import argparse
import json
import random
import sqlite3
import sys
from datetime import datetime, timezone

import db

POPULATIONS = {
    "battery": {
        "label": "Battery findings",
        "table": "evidence",
        "where": "confidence='verified'",
        "show": ("material_system", "specific_capacity_mah_g",
                 "current_density_ma_g", "cycle_count",
                 "capacity_retention_pct"),
    },
    "property": {
        "label": "Material properties",
        "table": "properties",
        "where": "confidence='verified'",
        "show": ("property_label", "value", "unit", "material"),
    },
    "battery-fulltext": {
        "label": "Battery findings read from full papers",
        "table": "evidence",
        "where": "confidence='verified' AND source_section='fulltext'",
        "show": ("material_system", "specific_capacity_mah_g", "cycle_count"),
    },
    "label": {
        "label": "The material named on a battery finding",
        "table": "evidence",
        "where": "confidence='verified' AND material_system IS NOT NULL",
        "show": ("material_system", "graphene_form", "specific_capacity_mah_g"),
    },
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS accuracy_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    population  TEXT NOT NULL,
    label       TEXT NOT NULL,
    rows_total  INTEGER NOT NULL,   -- how many rows the population holds
    sample      INTEGER NOT NULL,   -- how many were read
    right_      INTEGER NOT NULL,   -- how many were right
    unclear     INTEGER NOT NULL DEFAULT 0,
    seed        INTEGER,
    judged_by   TEXT,
    audited_at  TEXT NOT NULL,
    note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_pop ON accuracy_audit(population, audited_at);
"""


def ensure(conn):
    conn.executescript(SCHEMA)
    conn.commit()


def draw(conn, population, n, seed):
    spec = POPULATIONS[population]
    rows = conn.execute(
        f"SELECT rowid, * FROM {spec['table']} WHERE {spec['where']}").fetchall()
    total = len(rows)
    rnd = random.Random(seed)
    rnd.shuffle(rows)
    return spec, total, rows[:n]


def main():
    p = argparse.ArgumentParser(description="Measure how much of the library is right.")
    p.add_argument("--db", default=None)
    p.add_argument("--population", default="battery", choices=sorted(POPULATIONS))
    p.add_argument("--draw", type=int, default=20, help="how many rows to read")
    p.add_argument("--seed", type=int, default=None,
                   help="hand this to somebody else and they get the same rows")
    p.add_argument("--record", nargs=2, metavar=("RIGHT", "UNCLEAR"), type=int,
                   help="write down the verdict for a sample already read")
    p.add_argument("--by", default="hand", help="who judged it")
    p.add_argument("--note", default="")
    p.add_argument("--history", action="store_true", help="what has been audited")
    args = p.parse_args()

    conn = db.init(args.db)
    conn.row_factory = sqlite3.Row
    ensure(conn)

    if args.history:
        rows = conn.execute(
            "SELECT * FROM accuracy_audit ORDER BY audited_at DESC, id DESC").fetchall()
        if not rows:
            print("Nothing audited yet.")
        for r in rows:
            pct = 100 * r["right_"] / max(r["sample"], 1)
            print(f"  {r['audited_at'][:10]}  {r['label']:46}"
                  f" {r['right_']:3}/{r['sample']:<3} ({pct:3.0f}%)"
                  f"  of {r['rows_total']:,} rows  by {r['judged_by']}")
        conn.close()
        return

    seed = args.seed if args.seed is not None else random.randrange(1, 10**6)
    spec, total, sample = draw(conn, args.population, args.draw, seed)

    if args.record:
        right, unclear = args.record
        if right + unclear > args.draw:
            sys.exit("more verdicts than rows read")
        conn.execute(
            "INSERT INTO accuracy_audit(population, label, rows_total, sample,"
            " right_, unclear, seed, judged_by, audited_at, note)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (args.population, spec["label"], total, args.draw, right, unclear,
             args.seed, args.by,
             datetime.now(timezone.utc).isoformat(timespec="seconds"), args.note))
        conn.commit()
        pct = 100 * right / max(args.draw, 1)
        print(f"recorded: {right} of {args.draw} right ({pct:.0f}%)"
              f" for {spec['label'].lower()}, {total:,} rows in that population")
        conn.close()
        return

    print(f"{spec['label']}: {total:,} rows. Reading {len(sample)} of them,"
          f" seed {seed}.")
    print("Judge each against its own sentence, then record the count:")
    print(f"  python3 audit_accuracy.py --population {args.population}"
          f" --draw {args.draw} --seed {seed} --record <right> <unclear>\n")
    for i, r in enumerate(sample, 1):
        bits = []
        for f in spec["show"]:
            v = r[f] if f in r.keys() else None
            if v not in (None, ""):
                bits.append(f"{f.replace('_', ' ')}: {v}")
        print(f"{i:2}. {'  |  '.join(bits)}")
        print(f"    {(r['source_quote'] or '')[:230]}")
    conn.close()


if __name__ == "__main__":
    main()

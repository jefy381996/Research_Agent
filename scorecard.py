#!/usr/bin/env python3
"""Run a fixed set of questions and save the answers, so regressions show up.

Half the questions must be answered from the library and half must be refused.
Any drift in either direction is a regression and fails the run, which is what
makes this useful in CI rather than decorative.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from datetime import datetime, timezone

import answer
import db

MUST_ANSWER = [
    "What capacity do silicon graphene anodes reach in lithium-ion batteries?",
    "capacity retention of sulfur rGO cathodes in lithium-sulfur",
    "How many cycles do sodium-ion graphene anodes survive?",
    "coulombic efficiency of silicon graphene anodes",
    "What capacity do tin oxide graphene anodes reach?",
    "graphene aerogel sodium ion anode capacity",
    "rate capability of rGO cathodes in zinc-ion batteries",
    "capacity of MoS2 graphene composites",
    "Do graphene separators stop lithium dendrites?",
    "cycle life of holey graphene electrodes",
    "capacity retention of N-doped graphene anodes",
    "What capacity do Fe3O4 graphene anodes deliver?",
    "potassium-ion graphene anode capacity",
    "graphene oxide cathode capacity in lithium-sulfur",
    "first-cycle coulombic efficiency of hard carbon graphene anodes",
]

MUST_REFUSE = [
    "What is the melting point of tungsten?",
    "Who won the 2022 football world cup?",
    "What is the best pizza topping?",
    "How do I file a UK tax return?",
    "What is the capital of Mongolia?",
    "Write me a poem about the sea.",
    "What is the share price of Tesla?",
    "How do I treat a sprained ankle?",
    "Explain the plot of Hamlet.",
    "What is the airspeed velocity of an unladen swallow?",
    "Which graphene battery company should I invest in?",
    "What will battery prices be in 2030?",
    "How do I build a nuclear reactor?",
    "What is the best restaurant in Manchester?",
    "Translate hello into Japanese.",
]

FIELDS = ["question", "expected", "status", "mode", "evidence_rows", "papers",
          "citations", "summary", "pass"]


def main():
    parser = argparse.ArgumentParser(description="Run the fixed question scorecard.")
    parser.add_argument("--out", default="data/scorecard.csv")
    parser.add_argument("--db", default=None)
    args = parser.parse_args()

    conn = db.connect(args.db)
    if conn.execute("SELECT count(*) FROM evidence").fetchone()[0] == 0:
        print("The evidence table is empty. Run the pipeline first.")
        return 1

    rows, failures = [], []
    for question, expected in ([(q, "answered") for q in MUST_ANSWER]
                               + [(q, "not_found") for q in MUST_REFUSE]):
        try:
            result = answer.answer(question, conn=conn)
        except Exception as exc:          # one question never stops the run
            rows.append({"question": question, "expected": expected,
                         "status": "error", "mode": "", "evidence_rows": 0,
                         "papers": 0, "citations": 0,
                         "summary": f"{type(exc).__name__}: {exc}", "pass": "no"})
            failures.append((question, expected, "error"))
            continue
        ok = result["status"] == expected
        coverage = result.get("coverage", {})
        rows.append({
            "question": question,
            "expected": expected,
            "status": result["status"],
            "mode": result["mode"],
            "evidence_rows": coverage.get("evidence_rows", 0),
            "papers": coverage.get("papers", 0),
            "citations": len(result["citations"]),
            "summary": result["summary"][:400],
            "pass": "yes" if ok else "no",
        })
        if not ok:
            failures.append((question, expected, result["status"]))

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)

    passed = sum(1 for r in rows if r["pass"] == "yes")
    print(f"Scorecard: {passed}/{len(rows)} as expected")
    print(f"  answered when it should : "
          f"{sum(1 for r in rows if r['expected']=='answered' and r['pass']=='yes')}"
          f"/{len(MUST_ANSWER)}")
    print(f"  refused when it should  : "
          f"{sum(1 for r in rows if r['expected']=='not_found' and r['pass']=='yes')}"
          f"/{len(MUST_REFUSE)}")
    print(f"  written to              : {args.out}")

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    db.log_run(conn, "scorecard", now, now, passed, 0,
               [{"question": q, "expected": e, "got": g} for q, e, g in failures])
    conn.close()

    if failures:
        print("\nRegressions:")
        for question, expected, got in failures:
            print(f"  expected {expected:10} got {got:10} {question}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

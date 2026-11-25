#!/usr/bin/env python3
"""Read the measurements out of open-access full text.

An abstract gives a paper's headline result. The body gives every result the
paper measured, with the conditions each was measured under, which is what a
researcher actually asks for. collect_fulltext.py fetches those bodies into a
side database beside the library rather than in it, because the raw text is
input to this step and not something anybody downloads. This step turns it
into rows and writes them into the library, so the findings outlive the text.

A body is not a longer abstract. Read with the abstract extractors unchanged,
a sample of twenty-two rows came back about a third wrong - not wrong numbers,
wrong owners. A boron carbide modulus from someone else's introduction. ASTM
C330's minimum requirement. Graphene's textbook surface area, quoted as if
this paper had measured it. The control sample's value instead of the treated
one. An abstract is twelve hundred characters of the authors' own claims and
contains almost none of this; forty thousand characters of body is full of it.

Every guard below follows from one rule: in a body, the sentence has to speak
for itself. Nothing is inherited from the paper around it, because "the paper
around it" is now forty thousand characters of other people's work.

  Material. The shared extractors fall back to the whole paper's text when a
  sentence does not name what was measured. Over an abstract that fallback is
  the paper's own subject; over a body it is any material the paper happens to
  mention anywhere, which is how a boron carbide figure arrived labelled as
  graphene. Here the fallback sees the title and nothing else.

  Attribution. An introduction quotes prior work constantly. The citation
  markers that would flag it are gone - the collector strips them, because a
  marker dropped mid-sentence breaks the sentence the extractor is about to
  read - so the guard reads the prose, and for weaker signals asks where in
  the sentence the figure sits. A stripped citation leaves "( - )" or a
  doubled comma behind, and one of those next to the number is evidence about
  that number.

  General claims. "Typically less than 200 W/mK" is not a measurement, and
  neither is a standard's minimum or a theoretical maximum.

  Review sentences. A sentence that states three different properties at once
  is listing a material's known virtues, not reporting an experiment.

  Baselines. "Increased from 6.3 to 8.4 MPa" is two numbers, and the first one
  is what the authors were trying to beat.

  The abstract again. A finding already held from the abstract is not written
  twice, so the number that grows is new findings.
"""

import argparse
import io
import json
import os
import random
import re
import sqlite3
import sys
from datetime import datetime, timezone

import db
import extract_evidence as ev
from extract_evidence import (CONTROL, CONTROL_LOOKBACK,
                              OMITTED, is_baseline)
import extract_properties as pr
import plausibility

STORE = os.environ.get("FULLTEXT_DB", "data/fulltext.db")

# How many rows one paper may contribute. An abstract is about 1,200
# characters and is capped at six, roughly as many distinct results as an
# abstract states. A body is thirty times longer and reports many more, so the
# cap grows with length - but not in proportion, because past a point the
# extra length is method and discussion rather than new results.
CAP_BASE = 6
CHARS_PER_EXTRA_ROW = 4_000
CAP_MAX = 30

# Phrases that credit a figure to another paper wherever they sit in the
# sentence. "According to" is deliberately absent: it introduces this paper's
# own method ("calculated according to equation 2") far more often than
# somebody else's result.
CREDITED = re.compile(
    r"\bet\s+al\b"
    r"|\b(?:has|have|had|was|were|is|are)\s+been\s+(?:reported|observed|shown|"
    r"demonstrated|achieved)\b"
    r"|\b(?:previous|previously|earlier|prior)\s+(?:report|reports|reported|"
    r"published|work|works|studies|study|literature|paper|papers|result|results)\b"
    r"|\bin\s+the\s+literature\b"
    r"|\breported\s+(?:by|elsewhere|in\s+ref)\b"
    r"|\bcompared\s+(?:to|with)\s+(?:the\s+)?(?:reported|literature|previous)\b",
    re.I)

# Weaker signals: a surviving bracket citation, the doubled comma or the empty
# bracket left where a citation was stripped out. These say nothing on their
# own - a paper's own method is cited too - so they only count beside the
# figure.
MARKER = re.compile(r"\[\s*\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*\s*\]"
                    r"|\[\s*[,.;:-]*\s*\]"   # [ ] : all that is left
                    r"|,\s+,"
                    r"|\(\s*[–—-]\s*\)"
                    r"|\brefs?\.\s*\d", re.I)
MARKER_WINDOW = 80

# A general claim about what a material can do, a standard's requirement, or a
# textbook constant. None of them is a measurement this paper made.
GENERAL = re.compile(
    r"\btypical(?:ly)?\b|\bgenerally\b|\busually\b|\bin\s+general\b"
    r"|\btheoretical(?:ly)?\b|\bin\s+principle\b"
    r"|\bASTM\b|\bISO\s*\d|\bGB\s*/\s*T\b|\bstating\s+that\b"
    r"|\bminimum\s+(?:requirement|value|strength|allowable)\b"
    r"|\bstandard\s+(?:requires|specifies|states|stipulates)\b"
    r"|\bis\s+known\s+(?:to|for|as)\b"
    r"|\bis\s+often\s+(?:prized|used|regarded|considered)\b"
    r"|\b(?:unique|excellent|remarkable|outstanding|superior)\s+properties\b",
    re.I)

# Three different properties in one sentence is a list of a material's known
# virtues, not an experiment. Two is ordinary - a paper reports electrical and
# thermal conductivity of the same film in one breath.
MAX_FAMILIES = 3

# A neutral density filter's 50% transmittance is the instrument's, not the
# material's. "Laser" is deliberately absent: laser-induced graphene is a
# material and its sheet resistance is a real result.
INSTRUMENT = re.compile(
    r"\b(?:filter|objective|lens|detector|lamp|monochromator|grating|"
    r"aperture|neutral\s+density|photomultiplier)\b[^.]{0,24}$", re.I)
INSTRUMENT_LOOKBACK = 60

# The figures every graphene paper quotes in its introduction. They belong to
# the material in principle, not to the paper's own sample. A paper can
# legitimately measure near them - 2,600 m2/g of activated carbon is real -
# so a match is flagged rather than refused, and a flagged row stays
# searchable while never reaching an answer.
TEXTBOOK = {
    "surface_area": [2630.0],                        # single-layer SSA
    "carrier_mobility": [200000.0, 250000.0, 15000.0],
    "thermal_conductivity": [5000.0, 5300.0, 3000.0],
    "youngs_modulus": [1000.0, 1100.0],              # about 1 TPa
    "tensile_strength": [130000.0],                  # 130 GPa, stored in MPa
    "transmittance": [97.7, 97.4],
    "capacitance": [550.0],                          # the EDLC limit
}
TEXTBOOK_TOLERANCE = 0.015


def is_textbook(key, value) -> bool:
    """True when the figure is one the field quotes rather than measures."""
    for known in TEXTBOOK.get(key, ()):
        if abs(value - known) <= known * TEXTBOOK_TOLERANCE:
            return True
    return False



def credited_elsewhere(quote: str, figure) -> str | None:
    """Why this sentence's figure belongs to another paper, or None."""
    if CREDITED.search(quote):
        return "credited to another paper"
    if figure:
        at = quote.find(str(figure))
        if at >= 0:
            lo = max(0, at - MARKER_WINDOW)
            hi = at + len(str(figure)) + MARKER_WINDOW
            if MARKER.search(quote[lo:hi]):
                return "citation beside the figure"
    return None


def cap_for(chars: int) -> int:
    return min(CAP_MAX, CAP_BASE + chars // CHARS_PER_EXTRA_ROW)


def ev_figure(row) -> str | None:
    return (row.get("capacity_as_reported")
            or (f"{row['specific_capacity_mah_g']:g}"
                if row.get("specific_capacity_mah_g") else None))


def refuse(quote, figure, guard=True):
    """The reason this row is not a measurement by this paper, or None."""
    if not guard:
        return None
    if GENERAL.search(quote):
        return "a general claim, not a measurement"
    why = credited_elsewhere(quote, figure)
    if why:
        return why
    if is_baseline(quote, figure):
        return "the baseline of a from-to comparison"
    if figure:
        at = quote.find(str(figure))
        if at >= 0:
            if (CONTROL.search(quote[max(0, at - CONTROL_LOOKBACK):at])
                    or OMITTED.search(quote[:at])):
                return "the control sample's value"
            if INSTRUMENT.search(quote[max(0, at - INSTRUMENT_LOOKBACK):at]):
                return "the instrument's value, not the material's"
    return None


def findings(wid, title, body, cap, guard=True):
    """Every finding one body states, read one sentence at a time.

    The title is passed where the extractors expect the paper's text, so a
    sentence that does not name its material inherits from the title and not
    from forty thousand characters of body.
    """
    ev_rows, pr_rows, refused = [], [], []
    for sentence in ev.sentences(body):
        # Every guard is applied to a row and not to a sentence, so the count
        # of refusals means rows refused and can be compared with rows kept.
        # Screening sentences first was cheaper and reported 3,400 refusals
        # for 579 rows kept, nearly all of them sentences that held no
        # measurement at all - a number that looked like a verdict on the
        # guards and was really a verdict on prose.
        props = pr.rows_for_sentence(sentence, title, "", "fulltext")
        if guard and len({r["property_key"] for r in props}) >= MAX_FAMILIES:
            refused.append(("a review of known properties", sentence))
            props = []
        for row in props:
            if not pr.verify_text(row):
                continue
            why = refuse(sentence, row.get("value_as_reported"), guard)
            if why:
                refused.append((why, sentence))
                continue
            if guard and is_textbook(row["property_key"], row["value"]):
                row["flags"] = ";".join(filter(None, [
                    row.get("flags"), "quoted_textbook_value"]))
            if guard:
                # Four hand audits of twenty rows each put property rows read
                # from a body at about two thirds right, against about seven
                # eighths for the battery findings in the same bodies and
                # higher again for abstracts. The difference is the unit:
                # "mAh g-1" can only be a capacity, while a surface area or a
                # strength is a bare number beside a generic word, so every
                # stray figure in forty thousand characters is a candidate.
                #
                # Three rounds of guards did not close that gap - each round
                # caught the cases that prompted it and the next sample showed
                # new ones: an error bar, a modulus quoted beside a strength,
                # "are reported as", "agrees with a value of". The tail is
                # long enough that regular expressions will not reach it.
                #
                # So these rows are flagged rather than trusted. They stay
                # searchable and every one carries the sentence it came from,
                # but the answer path serves verified rows only, so none of
                # them can answer a question. Raising them to verified wants
                # a reader that can judge a sentence, not another pattern.
                row["flags"] = ";".join(filter(None, [
                    row.get("flags"), "read_from_paper_body"]))
                row["confidence"] = "flagged"
            row["openalex_id"] = wid
            row["row_hash"] = pr.row_hash(row)
            pr_rows.append(row)

        try:
            row = ev.extract_from_sentence(sentence, title, title, "fulltext")
        except Exception:
            row = None                    # one sentence never stops a paper
        if row:
            rejected, quote_ok = ev.verify_text(row, sentence)
            if not quote_ok:
                row["confidence"] = "unverified"
            if (row["specific_capacity_mah_g"] is not None
                    or row["capacity_retention_pct"] is not None):
                why = refuse(sentence, ev_figure(row), guard)
                if why:
                    refused.append((why, sentence))
                else:
                    row["openalex_id"] = wid
                    ev_rows.append(row)

        if len(ev_rows) >= cap and len(pr_rows) >= cap:
            break
    return ev_rows[:cap], pr_rows[:cap], refused


EV_SIGNATURE = ["material_system", "specific_capacity_mah_g", "cycle_count",
                "capacity_retention_pct", "current_density_ma_g"]


def _sig(row, fields):
    out = []
    for f in fields:
        v = row[f] if isinstance(row, sqlite3.Row) else row.get(f)
        if isinstance(v, float):
            v = round(v, 4)
        out.append(v)
    return tuple(out)


def held_from_abstract(conn, wid):
    """What the abstract already told us about this paper."""
    ev_rows = conn.execute(
        f"SELECT {','.join(EV_SIGNATURE)} FROM evidence"
        " WHERE openalex_id=? AND coalesce(source_section,'abstract')='abstract'",
        (wid,)).fetchall()
    pr_rows = conn.execute(
        "SELECT property_key, value, unit FROM properties"
        " WHERE openalex_id=? AND coalesce(source_section,'abstract')='abstract'",
        (wid,)).fetchall()
    return ({_sig(r, EV_SIGNATURE) for r in ev_rows},
            {_sig(r, ["property_key", "value", "unit"]) for r in pr_rows})


def ensure_state(conn):
    """Which papers have been read already.

    Kept in the library rather than the side database because the collector
    holds that file open for writing while a run is in flight, and a reader
    waiting on its commit would stall for no reason. make_shippable drops this
    table, the way it drops the other working tables.
    """
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS fulltext_seen (
        openalex_id  TEXT PRIMARY KEY,
        chars        INTEGER,
        ev_rows      INTEGER,
        prop_rows    INTEGER,
        dropped_cite INTEGER,
        dropped_dupe INTEGER,
        read_at      TEXT
    );""")
    conn.commit()


def main():
    p = argparse.ArgumentParser(
        description="Extract measurements from collected open-access full text.")
    p.add_argument("--db", default=None, help="the library")
    p.add_argument("--store", default=STORE, help="where the body text is kept")
    p.add_argument("--limit", type=int, default=None,
                   help="read only the first N papers, longest first")
    p.add_argument("--all", action="store_true",
                   help="re-read papers already read, instead of only new ones")
    p.add_argument("--dry-run", action="store_true", help="report, write nothing")
    p.add_argument("--no-guards", action="store_true",
                   help="read the body as if it were an abstract, for comparison")
    p.add_argument("--show", type=int, default=0, help="print N kept findings")
    p.add_argument("--show-refused", type=int, default=0,
                   help="print N sentences the guards refused")
    p.add_argument("--seed", type=int, default=7, help="which sample to print")
    p.add_argument("--dump", default=None,
                   help="write every candidate row to this file, tab separated,"
                        " for auditing by eye")
    args = p.parse_args()
    guard = not args.no_guards

    if not os.path.exists(args.store):
        sys.exit(f"No full text collected yet: {args.store} does not exist.\n"
                 f"Run collect_fulltext.py first.")

    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn = db.init(args.db)
    conn.row_factory = sqlite3.Row
    ensure_state(conn)

    store = sqlite3.connect(args.store, timeout=120)
    store.row_factory = sqlite3.Row

    done = set()
    if not args.all:
        done = {r[0] for r in conn.execute("SELECT openalex_id FROM fulltext_seen")}

    todo = [r for r in store.execute(
        "SELECT openalex_id, chars FROM paper_fulltext ORDER BY chars DESC")
        if r["openalex_id"] not in done]
    if args.limit:
        todo = todo[:args.limit]

    held = store.execute("SELECT count(*), coalesce(sum(chars),0)"
                         " FROM paper_fulltext").fetchone()
    print(f"Full text collected   : {held[0]:,} papers,"
          f" {held[1]/1e6:.1f}M characters")
    print(f"Already read          : {len(done):,}")
    print(f"To read now           : {len(todo):,}"
          f"{'' if guard else '   (guards off)'}")
    if not todo:
        print("\nNothing new to read.")
        conn.close(); store.close()
        return

    ev_all, pr_all = [], []
    kept_examples, refused_examples = [], []
    seen_rows = []
    chars_read = failed = 0
    dropped_guard = dropped_dupe = 0

    for item in todo:
        wid = item["openalex_id"]
        try:
            rec = store.execute(
                "SELECT body FROM paper_fulltext WHERE openalex_id=?",
                (wid,)).fetchone()
            body = (rec["body"] if rec else "") or ""
            if not body:
                continue
            row = conn.execute("SELECT title FROM papers WHERE openalex_id=?",
                               (wid,)).fetchone()
            title = (row["title"] if row else "") or ""
            ev_rows, pr_rows, refused = findings(
                wid, title, body, cap_for(len(body)), guard)
        except Exception:
            failed += 1               # one paper never stops the run
            continue

        chars_read += len(body)
        ev_seen, pr_seen = held_from_abstract(conn, wid)
        my_dupe = 0

        keep_ev = []
        for r in ev_rows:
            sig = _sig(r, EV_SIGNATURE)
            if sig in ev_seen:
                my_dupe += 1
                continue
            ev_seen.add(sig)
            keep_ev.append(r)

        keep_pr = []
        for r in pr_rows:
            sig = _sig(r, ["property_key", "value", "unit"])
            if sig in pr_seen:
                my_dupe += 1
                continue
            pr_seen.add(sig)
            keep_pr.append(r)

        ev_all.extend(keep_ev)
        pr_all.extend(keep_pr)
        dropped_guard += len(refused)
        dropped_dupe += my_dupe
        refused_examples.extend(refused)
        kept_examples.extend(
            [("evidence", r["source_quote"],
              f"{r['material_system']} {r['specific_capacity_mah_g']} mAh/g")
             for r in keep_ev]
            + [("property", r["source_quote"],
                f"{r['property_label']} {r['value_as_reported']} {r['unit']}")
               for r in keep_pr])
        seen_rows.append((wid, len(body), len(keep_ev), len(keep_pr),
                          len(refused), my_dupe))

    plausibility.assess(ev_all)

    print(f"\nRead                  : {len(seen_rows):,} papers,"
          f" {chars_read/1e6:.1f}M characters  ({failed} raised)")
    print(f"New measurements      : {len(ev_all):,} battery findings,"
          f" {len(pr_all):,} property rows")
    print(f"Refused by the guards : {dropped_guard:,}")
    print(f"Already in the abstract: {dropped_dupe:,}")
    counts = {}
    for row in ev_all:
        counts[row["confidence"]] = counts.get(row["confidence"], 0) + 1
    print(f"  verified / flagged / unverified : {counts.get('verified',0)}"
          f" / {counts.get('flagged',0)} / {counts.get('unverified',0)}")

    rnd = random.Random(args.seed)
    if args.show and kept_examples:
        print("\n--- kept, with the sentence it came from ---")
        for kind, quote, what in rnd.sample(
                kept_examples, min(args.show, len(kept_examples))):
            print(f"\n  [{kind}] {what}")
            print(f"    {quote[:260]}")
    if args.show_refused and refused_examples:
        print("\n--- refused, with the reason ---")
        for why, quote in rnd.sample(
                refused_examples, min(args.show_refused, len(refused_examples))):
            print(f"\n  ({why})")
            print(f"    {quote[:260]}")

    if args.dump:
        with io.open(args.dump, "w", encoding="utf-8") as fh:
            fh.write("kind\tkey\tvalue\tunit\tas_reported\tmaterial\tquote\n")
            for r in ev_all:
                fh.write("\t".join(str(x).replace("\t", " ") for x in (
                    "evidence", "specific_capacity_mah_g",
                    r.get("specific_capacity_mah_g"), "mAh/g",
                    r.get("capacity_as_reported"), r.get("material_system"),
                    r["source_quote"][:400])) + "\n")
            for r in pr_all:
                fh.write("\t".join(str(x).replace("\t", " ") for x in (
                    "property", r.get("property_key"), r.get("value"),
                    r.get("unit"), r.get("value_as_reported"), r.get("material"),
                    r["source_quote"][:400])) + "\n")
        print(f"\nEvery candidate row written to {args.dump} for auditing.")

    if args.dry_run:
        print("\nDRY RUN: nothing written.")
        conn.close(); store.close()
        return

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    touched = [r[0] for r in seen_rows]

    # A re-run must land exactly where the last one did, so this paper's
    # full-text rows go before the new ones arrive. Abstract rows are left
    # alone: they are a separate reading of a separate text.
    for start in range(0, len(touched), 400):
        batch = touched[start:start + 400]
        marks = ",".join("?" * len(batch))
        conn.execute(f"DELETE FROM evidence WHERE source_section='fulltext'"
                     f" AND openalex_id IN ({marks})", batch)
        conn.execute(f"DELETE FROM properties WHERE source_section='fulltext'"
                     f" AND openalex_id IN ({marks})", batch)
    conn.commit()

    written_ev = written_pr = insert_failed = 0
    ev_sql = (f"INSERT INTO evidence({','.join(ev.INSERT_FIELDS)})"
              f" VALUES({','.join('?' * len(ev.INSERT_FIELDS))})"
              f" ON CONFLICT(row_hash) DO UPDATE SET "
              + ",".join(f"{f}=excluded.{f}" for f in ev.INSERT_FIELDS
                         if f != "row_hash"))
    for row in ev_all:
        row.pop("_derived", None)
        row["row_hash"] = ev.row_hash(row)
        row["flags"] = json.dumps(row.get("flags") or [])
        row["extracted_at"] = now
        try:
            conn.execute(ev_sql, [row.get(f) for f in ev.INSERT_FIELDS])
            written_ev += 1
        except Exception:
            insert_failed += 1

    pr_sql = (f"INSERT INTO properties({','.join(pr.INSERT_FIELDS)})"
              f" VALUES({','.join('?' * len(pr.INSERT_FIELDS))})"
              f" ON CONFLICT(row_hash) DO UPDATE SET"
              f" confidence=excluded.confidence, flags=excluded.flags,"
              f" extracted_at=excluded.extracted_at")
    for row in pr_all:
        row["extracted_at"] = now
        if isinstance(row.get("flags"), list):
            row["flags"] = ";".join(row["flags"]) or None
        try:
            conn.execute(pr_sql, [row.get(f) for f in pr.INSERT_FIELDS])
            written_pr += 1
        except Exception:
            insert_failed += 1

    conn.executemany(
        "INSERT INTO fulltext_seen(openalex_id, chars, ev_rows, prop_rows,"
        " dropped_cite, dropped_dupe, read_at) VALUES(?,?,?,?,?,?,?)"
        " ON CONFLICT(openalex_id) DO UPDATE SET chars=excluded.chars,"
        " ev_rows=excluded.ev_rows, prop_rows=excluded.prop_rows,"
        " dropped_cite=excluded.dropped_cite, dropped_dupe=excluded.dropped_dupe,"
        " read_at=excluded.read_at",
        [(w, c, e, pp, dc, dd, now) for w, c, e, pp, dc, dd in seen_rows])
    conn.commit()

    db.log_run(conn, "extract_fulltext", started,
               datetime.now(timezone.utc).isoformat(timespec="seconds"),
               written_ev + written_pr, 0,
               [{"reason": "insert failed", "count": insert_failed}]
               if insert_failed else [])

    ev_total = conn.execute("SELECT count(*) FROM evidence").fetchone()[0]
    pr_total = conn.execute("SELECT count(*) FROM properties").fetchone()[0]
    ev_ft = conn.execute("SELECT count(*) FROM evidence"
                         " WHERE source_section='fulltext'").fetchone()[0]
    pr_ft = conn.execute("SELECT count(*) FROM properties"
                         " WHERE source_section='fulltext'").fetchone()[0]
    print(f"\nWritten               : {written_ev:,} + {written_pr:,}"
          f"  ({insert_failed} refused by the library)")
    print(f"Library now holds     : {ev_total:,} battery findings"
          f" ({ev_ft:,} from full text), {pr_total:,} property rows"
          f" ({pr_ft:,} from full text)")
    conn.close(); store.close()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Fetch open-access full text for papers already in the library.

Why this exists: the library reads abstracts. An abstract is a summary, and
the numbers a researcher wants are in the results section - a measured pilot
over five papers found 7.5 times as many measurements in the full text as in
the abstract of the same paper, from about 39,000 characters against 1,200.

What it can actually reach is the limit, and it is smaller than it sounds.
Europe PMC holds the open-access subset of the literature, which leans
biomedical; this library is materials science, published largely by ACS,
Wiley, RSC and Elsevier. A sample of 120 measurement-bearing papers found
about 18 per cent marked as present in Europe PMC and only about 4 per cent
whose full text could actually be retrieved - "inEPMC" is set for records
that are abstract-only there too. So this script reports coverage as it goes
rather than assuming it, and the number it prints is the number to believe.

Nothing is scraped. Europe PMC publishes this subset for text mining and
asks for no key. Papers it does not have are left alone; their abstract
stays, and the library goes on linking to the publisher.

Re-running is safe and resumes: every paper fetched is recorded, and a run
that stops - for a refusal, a timeout, or because it was interrupted - keeps
everything it already had.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import sqlite3

import db

REST = "https://www.ebi.ac.uk/europepmc/webservices/rest"
# Two endpoints, two content types. Asking the full-text endpoint for JSON
# gets 406 Not Acceptable from it, and the first version sent one Accept
# header to both: every full text was refused, and because a refusal was
# being read as "this paper has none", the answer came back as nought per
# cent coverage rather than as an error.
UA = "graphene-research-agent/1.0"
JSON_HEADERS = {"Accept": "application/json", "User-Agent": UA}
XML_HEADERS = {"Accept": "application/xml, text/xml;q=0.9, */*;q=0.8",
               "User-Agent": UA}
PAUSE = 0.25                 # polite spacing between calls
MAX_TRIES = 5
MIN_BODY = 2500              # shorter than this is not a paper
CHECKPOINT_EVERY = 100
DEAD_BATCHES = 3             # this many wholly failed batches means it is gone
SERVER_ERROR_TRIES = 2       # a 500 on one record is about that record


class Stopped(RuntimeError):
    """The service stopped serving us. Keep what has been collected."""


def fetch(url, timeout=45, headers=None):
    last = ""
    for attempt in range(1, MAX_TRIES + 1):
        try:
            req = urllib.request.Request(url, headers=headers or JSON_HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return ""                      # simply not there: a real answer
            last = f"HTTP {exc.code}"
            if exc.code in (429, 503):
                # Being asked to slow down is an instruction, not a failure.
                time.sleep(min(3 ** attempt, 45))
                continue
            if exc.code < 500:
                # Anything else in the 400s is us asking wrongly, and must not
                # be mistaken for the paper not existing. That mistake read as
                # nought per cent coverage for a whole run.
                raise Stopped(f"Europe PMC refused the request: HTTP {exc.code}"
                              f" for {url.split('/')[-1]}")
            # A 500 here is this record, not the service: Europe PMC cannot
            # render the XML for some papers and says so every time. Measured
            # on six, three of them answered 500 immediately and consistently.
            # Trying five times with backoff spends half a minute to learn
            # what the second attempt already knew.
            if exc.code >= 500 and attempt >= SERVER_ERROR_TRIES:
                raise Stopped(f"Europe PMC could not serve that record: "
                              f"HTTP {exc.code}")
        except Exception as exc:               # network, timeout, bad bytes
            last = f"{type(exc).__name__}"
        if attempt < MAX_TRIES:
            time.sleep(2 ** attempt)
    raise Stopped(f"Europe PMC did not answer: {last}")


# JATS is an article in XML. The parts worth reading are the body paragraphs;
# the reference list, the author addresses and the citation markers are not,
# and a citation marker dropped into the middle of a sentence breaks the
# sentence the extractor is about to read.
DROP = re.compile(
    r"<(ref-list|back|front|table-wrap-foot|fn-group|author-notes|"
    r"article-meta|journal-meta)\b.*?</\1>", re.S | re.I)
XREF = re.compile(r"<xref\b.*?</xref>", re.S | re.I)
TAGS = re.compile(r"<[^>]+>")
ENTS = {"&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'",
        "&#x000a0;": " ", "&#160;": " ", "&nbsp;": " ",
        "&#8722;": "-", "&#x2212;": "-", "&#8211;": "-", "&#8212;": "-"}


def readable(xml: str) -> str:
    if not xml:
        return ""
    text = DROP.sub(" ", xml)
    text = XREF.sub(" ", text)
    text = TAGS.sub(" ", text)
    for k, v in ENTS.items():
        text = text.replace(k, v)
    text = re.sub(r"&#x?[0-9a-fA-F]+;", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def licence_of(record: dict) -> str:
    return (record.get("license") or record.get("licence") or "").strip()


BATCH = 50


def lookup_many(dois: list[str]) -> dict:
    """Records for a batch of DOIs, keyed by lower-case DOI.

    One DOI per request took six and a half seconds through to Europe PMC and
    would have put eleven hours between here and the measurement-bearing
    papers alone. Fifty in one query answers in about four, which is seventy
    times less waiting per paper, and asks the service for a seventieth as
    many connections.
    """
    if not dois:
        return {}
    query = " OR ".join(f'DOI:"{d}"' for d in dois)
    url = (f"{REST}/search?query={urllib.parse.quote(query)}"
           f"&format=json&resultType=core&pageSize={len(dois) * 2}")
    raw = fetch(url, timeout=90)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    out = {}
    for rec in (data.get("resultList") or {}).get("result") or []:
        key = (rec.get("doi") or "").strip().lower()
        if key and key not in out:
            out[key] = rec
    return out


FULLTEXT_DB = "data/fulltext.db"


# The bodies are too big to keep and do not need keeping: they are read into
# measurements in the same run that fetches them, and the measurements are
# what ship. The ledger of what was tried is a different thing. It is small,
# it is the only record of three hours of asking, and without it a fresh
# container asks Europe PMC for the same thirty-five thousand papers again.
# So the bodies stay in the file that is not committed, and this goes in.
LEDGER = "data/fulltext-tried.csv.gz"


def load_ledger(store, path=LEDGER) -> int:
    """Seed the attempt ledger from the committed copy, if there is one."""
    if not os.path.exists(path):
        return 0
    rows = []
    try:
        with gzip.open(path, "rt", encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                if row.get("openalex_id"):
                    rows.append((row["openalex_id"], row.get("outcome") or "",
                                 row.get("tried_at") or ""))
    except Exception as exc:                 # a broken ledger costs requests,
        print(f"  could not read {path}: {exc}", file=sys.stderr)
        return 0                             # not correctness
    store.executemany("INSERT OR IGNORE INTO fulltext_tried"
                      "(openalex_id, outcome, tried_at) VALUES(?,?,?)", rows)
    store.commit()
    return len(rows)


def save_ledger(store, path=LEDGER) -> int:
    """Write the ledger out, atomically, so a run cut off keeps it."""
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    n = 0
    with gzip.open(tmp, "wt", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["openalex_id", "outcome", "tried_at"])
        for row in store.execute("SELECT openalex_id, outcome, tried_at"
                                 " FROM fulltext_tried ORDER BY openalex_id"):
            writer.writerow(row)
            n += 1
    os.replace(tmp, path)
    return n


def open_store(path):
    """Full text lives in its own file, beside the library rather than in it.

    Nine thousand papers is something like three hundred megabytes of body
    text. The shipped database has to stay under the hundred a git host
    accepts, and it was already at ninety-nine with the first twenty-nine
    papers in it. Keeping the text in a separate file means the library
    cannot be pushed over the limit by a collection run, and the text is
    input to extraction rather than something anybody downloads: it is read
    once to pull the measurements out, and the measurements are what ship.
    """
    store = sqlite3.connect(path)
    store.row_factory = sqlite3.Row
    ensure_table(store)
    return store


def ensure_table(conn):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS paper_fulltext (
        openalex_id TEXT PRIMARY KEY,
        source      TEXT,      -- where it came from, e.g. europepmc
        external_id TEXT,      -- e.g. PMC1234567
        licence     TEXT,
        chars       INTEGER,
        body        TEXT,
        fetched_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS fulltext_tried (
        openalex_id TEXT PRIMARY KEY,
        outcome     TEXT,      -- got | no-record | no-fulltext | too-short
        tried_at    TEXT
    );
    """)
    conn.commit()


def main():
    ap = argparse.ArgumentParser(description="Fetch open-access full text.")
    ap.add_argument("--db", default=None)
    ap.add_argument("--fulltext-db", default=FULLTEXT_DB,
                    help="where the body text is kept, outside the library")
    ap.add_argument("--limit", type=int, default=0,
                    help="stop after this many papers are tried (0 = all)")
    ap.add_argument("--measured-first", action="store_true",
                    help="start with papers that already gave a measurement")
    ap.add_argument("--retry-missing", action="store_true",
                    help="try papers that were tried before and had nothing")
    ap.add_argument("--oa-status", default="gold,diamond,hybrid,bronze,green",
                    help="which kinds of open access to try, best first; "
                         "empty string tries everything including closed")
    ap.add_argument("--workers", type=int, default=3,
                    help="how many full texts to fetch at once")
    args = ap.parse_args()

    conn = db.connect(args.db)          # the library: read only, here
    store = open_store(args.fulltext_db)  # the text: written here
    # Seed from the committed ledger before working out what is left. In a
    # fresh container the text file does not exist and this is the only thing
    # standing between the run and asking for every paper a second time.
    seeded = load_ledger(store)
    if seeded:
        print(f"  ledger   : {seeded:,} papers already tried in earlier runs")

    # Only open-access papers are worth asking about, and the kind of open
    # access predicts the answer. Measured on a hundred of each: gold 54 per
    # cent retrievable, any open access 35, and papers taken in order of
    # citations nearly nought - because the most-cited work is in the closed
    # journals, so sorting by citations sorts away from what can be read.
    order = ("JOIN (SELECT openalex_id FROM evidence UNION SELECT openalex_id "
             "FROM properties) m ON m.openalex_id = p.openalex_id"
             if args.measured_first else "")
    # What has already been tried and held lives in the other file, so the
    # list of what to skip is read from there and passed in.
    held = {r[0] for r in store.execute("SELECT openalex_id FROM paper_fulltext")}
    seen = set() if args.retry_missing else {
        r[0] for r in store.execute("SELECT openalex_id FROM fulltext_tried")}
    kinds = args.oa_status.split(",") if args.oa_status else []
    oa = (" AND p.oa_status IN (%s)" % ",".join("?" * len(kinds))) if kinds else ""
    sql = (f"SELECT p.openalex_id, p.doi, p.title FROM papers p {order}"
           f" WHERE p.doi IS NOT NULL AND p.doi != ''"
           f"{oa}"
           f" ORDER BY CASE p.oa_status WHEN 'gold' THEN 0 WHEN 'diamond' THEN 1"
           f"   WHEN 'hybrid' THEN 2 WHEN 'bronze' THEN 3 ELSE 4 END,"
           f" p.citations_per_year DESC")
    todo = [dict(r) for r in conn.execute(sql, kinds)]
    todo = [t for t in todo
            if t["openalex_id"] not in held and t["openalex_id"] not in seen]
    if args.limit:
        todo = todo[:args.limit]

    print("Full-text collection")
    print(f"  source   : Europe PMC open-access subset")
    print(f"  kinds    : {args.oa_status or 'every paper'}")
    print(f"  to try   : {len(todo):,} papers"
          + (" (measurement-bearing first)" if args.measured_first else ""))
    print(f"  workers  : {args.workers}")
    print(flush=True)

    counts = {"got": 0, "no-record": 0, "no-fulltext": 0, "too-short": 0,
              "server-error": 0}
    chars = 0
    refused = 0
    dead_batches = 0
    last_failure = ""
    stopped = None
    started = time.time()
    now = lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def note(wid, outcome):
        store.execute("INSERT OR REPLACE INTO fulltext_tried"
                      "(openalex_id, outcome, tried_at) VALUES(?,?,?)",
                      (wid, outcome, now()))

    done = 0
    try:
        for start in range(0, len(todo), BATCH):
            batch = todo[start:start + BATCH]
            try:
                found = lookup_many([b["doi"] for b in batch])
            except Stopped as exc:
                stopped = str(exc); break

            # One request per paper for the text itself, and they are the
            # slow half - several seconds each through to the service. Asking
            # for a few at once turns an afternoon into an hour; the number
            # is small on purpose, because this is somebody else's server.
            wanted = []
            for paper in batch:
                rec = found.get((paper["doi"] or "").strip().lower())
                if rec and rec.get("pmcid") and str(rec.get("inEPMC", "N")) == "Y":
                    wanted.append((paper["openalex_id"], rec["pmcid"]))

            bodies, failures = {}, []
            if wanted:
                def grab(pair):
                    wid, pmcid = pair
                    try:
                        return wid, readable(fetch(f"{REST}/{pmcid}/fullTextXML",
                                                   timeout=60, headers=XML_HEADERS)), None
                    except Stopped as exc:
                        return wid, None, str(exc)
                with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
                    for wid, body, why in pool.map(grab, wanted):
                        bodies[wid] = body
                        if why:
                            failures.append(why)

            # One refusal is not a reason to abandon a three hour collection.
            # The paper is left for a later run and the rest carries on; only
            # when whole batches keep failing is the service actually gone.
            # The first version stopped on the first refusal and reported it
            # as "Europe PMC stopped answering", throwing away the code that
            # said what had really happened.
            if failures and len(failures) == len(wanted):
                dead_batches += 1
                last_failure = failures[0]
                if dead_batches >= DEAD_BATCHES:
                    stopped = f"{last_failure} ({dead_batches} batches in a row)"
            else:
                dead_batches = 0
            if failures:
                refused += len(failures)

            for paper in batch:
                wid = paper["openalex_id"]
                rec = found.get((paper["doi"] or "").strip().lower())
                done += 1
                if not rec:
                    counts["no-record"] += 1; note(wid, "no-record"); continue
                pmcid = rec.get("pmcid") or ""
                body = bodies.get(wid) or ""
                if wid in bodies and bodies[wid] is None:
                    # Asked for and refused. Recorded as its own outcome so
                    # the next run does not spend the same seconds on the
                    # same broken record, and --retry-missing can still come
                    # back to it if the service is ever fixed.
                    counts["server-error"] += 1
                    note(wid, "server-error")
                    continue
                if not body:
                    counts["no-fulltext"] += 1; note(wid, "no-fulltext")
                elif len(body) < MIN_BODY:
                    counts["too-short"] += 1; note(wid, "too-short")
                else:
                    store.execute(
                        "INSERT OR REPLACE INTO paper_fulltext"
                        "(openalex_id, source, external_id, licence, chars, body, fetched_at)"
                        " VALUES(?,?,?,?,?,?,?)",
                        (wid, "europepmc", pmcid, licence_of(rec), len(body), body, now()))
                    note(wid, "got")
                    counts["got"] += 1
                    chars += len(body)
            # Every batch, not every hundred papers: a run that is cut off
            # should lose one query's worth of work, not a hundred. The ledger
            # goes out with it, because the run being cut off is the case it
            # exists for.
            store.commit()
            save_ledger(store)
            rate = done / max(time.time() - started, 1e-9)
            left = (len(todo) - done) / max(rate, 1e-9)
            print(f"  {done:,}/{len(todo):,} tried, {counts['got']:,} with full text "
                  f"({100 * counts['got'] / max(done, 1):.1f}%), "
                  f"{chars / 1e6:.1f}M chars"
                  + (f", {refused} refused" if refused else "")
                  + f", ~{left / 60:.0f} min left", flush=True)
            if stopped:
                break
            time.sleep(PAUSE)
    except KeyboardInterrupt:
        stopped = "interrupted"
    finally:
        store.commit()
        save_ledger(store)

    tried = sum(counts.values())
    print()
    print(f"Papers tried                : {tried:,}")
    for key in ("got", "no-record", "no-fulltext", "too-short", "server-error"):
        print(f"  {key:<24}{counts[key]:>8,}")
    if tried:
        print(f"Coverage                    : {100 * counts['got'] / tried:.1f}%")
    print(f"Characters collected        : {chars:,}")
    if refused:
        print(f"Refused, to try again later : {refused:,}")
        print(f"  last reason               : {last_failure}")
    total = store.execute("SELECT count(*), coalesce(sum(chars), 0) "
                          "FROM paper_fulltext").fetchone()
    print(f"Full texts held in total    : {total[0]:,} ({total[1] / 1e6:.1f}M characters)")
    print(f"Kept in                     : {args.fulltext_db} (outside the library)")
    conn.close()
    store.close()

    if stopped:
        sys.exit(f"\nSTOPPED EARLY: {stopped}\n"
                 f"  Everything fetched so far is saved. Re-run the same "
                 f"command to carry on; nothing already fetched is fetched again.")


if __name__ == "__main__":
    main()

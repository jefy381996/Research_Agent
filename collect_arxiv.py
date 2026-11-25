#!/usr/bin/env python3
"""Collect papers from arXiv, and widen the library past graphene.

Two reasons this source is worth having beside OpenAlex.

The abstracts are better. OpenAlex reconstructs an abstract from an inverted
index and the result is serviceable; arXiv gives the author's own text, longer
and with the conditions intact. A single arXiv abstract routinely carries
"delivers a reversible capacity of about 130 mAh/g at 0.2 C and retains 74
mAh/g after 1000 cycles", which is four facts the extractors can hold onto.

And it reaches the materials next door. A tool that only knows graphene can
only answer about graphene, and a researcher comparing graphene against MXene
or molybdenum disulfide has to go somewhere else - which is the moment the
tool stops being useful. These searches cover the 2D materials and the battery
chemistries graphene is actually weighed against.

Rows arrive labelled with where they came from, as preprints, so nothing here
is mistaken for a peer-reviewed figure. The same discipline the library
already applies to its no-graphene searches applies here: a paper that is not
about graphene is labelled with the material it was measured on, and is not
used to answer a question about graphene.

arXiv asks for three seconds between requests and that is what this waits.
Running it twice is safe: a paper already held is updated, never duplicated,
and the progress file lets a run that is cut off carry on where it stopped.
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import requests

import db

API = "https://export.arxiv.org/api/query"
PAUSE = 3.0                  # what arXiv asks for between requests
PAGE = 100
MAX_TRIES = 4
TIMEOUT = 60
PROGRESS = "data/.arxiv-progress.json"
NS = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}

# Each search is (name, arXiv query, is_graphene). The last says whether a row
# from it may answer a question about graphene; everything else is the field
# graphene sits in, kept so the tool can compare rather than only recite.
SEARCHES = [
    ("graphene-battery", 'abs:"graphene" AND (abs:"anode" OR abs:"cathode")', True),
    ("graphene-supercapacitor", 'abs:"graphene" AND abs:"supercapacitor"', True),
    ("graphene-thermal", 'abs:"graphene" AND abs:"thermal conductivity"', True),
    ("graphene-membrane", 'abs:"graphene oxide" AND abs:"membrane"', True),
    ("graphene-sensor", 'abs:"graphene" AND abs:"sensor"', True),
    ("mxene", 'abs:"MXene"', False),
    ("mxene-energy", 'abs:"MXene" AND (abs:"battery" OR abs:"supercapacitor")', False),
    ("mos2", 'abs:"MoS2" AND (abs:"anode" OR abs:"battery")', False),
    ("tmd", 'abs:"transition metal dichalcogenide"', False),
    ("hbn", 'abs:"hexagonal boron nitride"', False),
    ("phosphorene", 'abs:"black phosphorus" OR abs:"phosphorene"', False),
    ("silicon-anode", 'abs:"silicon anode" AND abs:"lithium"', False),
    ("solid-state", 'abs:"solid-state electrolyte" AND abs:"battery"', False),
    ("sodium-ion", 'abs:"sodium-ion battery" AND abs:"anode"', False),
    ("potassium-ion", 'abs:"potassium-ion battery"', False),
    ("lithium-sulfur", 'abs:"lithium-sulfur battery"', False),
    ("zinc-ion", 'abs:"zinc-ion battery"', False),
    ("carbon-nanotube", 'abs:"carbon nanotube" AND (abs:"anode" OR abs:"composite")', False),
    ("thermal-interface", 'abs:"thermal interface material"', False),
]


def load_progress():
    if os.path.exists(PROGRESS):
        try:
            with open(PROGRESS, encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            pass
    return {"done": {}, "started": None}


def save_progress(state):
    tmp = PROGRESS + ".tmp"
    os.makedirs(os.path.dirname(PROGRESS), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=1)
    os.replace(tmp, PROGRESS)


def fetch(query, start, page):
    """One page of results, or None when arXiv will not serve it."""
    url = (f"{API}?search_query={urllib.parse.quote(query)}"
           f"&start={start}&max_results={page}"
           f"&sortBy=submittedDate&sortOrder=descending")
    for attempt in range(1, MAX_TRIES + 1):
        try:
            r = requests.get(url, timeout=TIMEOUT,
                             headers={"User-Agent": "research-agent (collector)"})
        except requests.RequestException as exc:
            last = f"{type(exc).__name__}: {exc}"
        else:
            if r.status_code == 200:
                return r.text
            last = f"HTTP {r.status_code}"
        if attempt < MAX_TRIES:
            time.sleep(PAUSE * attempt * 2)
    print(f"    giving up on this page: {last}", file=sys.stderr)
    return None


def entries(xml_text):
    """Every paper in one page, as plain dictionaries."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        print(f"    unreadable page: {exc}", file=sys.stderr)
        return [], 0
    total = root.findtext("opensearch:totalResults", default="0",
                          namespaces={"opensearch":
                                      "http://a9.com/-/spec/opensearch/1.1/"})
    out = []
    for e in root.findall("a:entry", NS):
        raw_id = (e.findtext("a:id", default="", namespaces=NS) or "").strip()
        if not raw_id:
            continue
        # http://arxiv.org/abs/2609.32707v1 -> arXiv:2609.32707
        ident = raw_id.rsplit("/", 1)[-1].split("v")[0]
        published = (e.findtext("a:published", default="", namespaces=NS) or "")[:10]
        pdf = ""
        for link in e.findall("a:link", NS):
            if link.get("title") == "pdf":
                pdf = link.get("href") or ""
        out.append({
            "openalex_id": f"arXiv:{ident}",
            "doi": (e.findtext("arxiv:doi", default="", namespaces=NS) or "").strip() or None,
            "title": " ".join((e.findtext("a:title", default="", namespaces=NS) or "").split()),
            "abstract": " ".join((e.findtext("a:summary", default="", namespaces=NS) or "").split()),
            "year": int(published[:4]) if published[:4].isdigit() else None,
            "publication_date": published or None,
            "journal": (e.findtext("arxiv:journal_ref", default="", namespaces=NS) or "").strip() or "arXiv",
            "publisher": "arXiv",
            "authors": "; ".join(
                (a.findtext("a:name", default="", namespaces=NS) or "").strip()
                for a in e.findall("a:author", NS)),
            "landing_url": raw_id.replace("http://", "https://"),
            "pdf_url": pdf,
        })
    try:
        return out, int(total)
    except ValueError:
        return out, 0


FIELDS = ["openalex_id", "doi", "title", "year", "publication_date", "journal",
          "publisher", "authors", "abstract", "landing_url", "pdf_url",
          "oa_status", "licence", "full_text_reusable", "source",
          "source_queries", "is_preprint", "cited_by_count",
          "citations_per_year", "fetched_at", "first_seen"]


def store(conn, rows, query_name):
    """Write a page. A paper already held is updated, never duplicated, and
    first_seen is left alone so "what is new" keeps meaning something."""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    assignments = ",".join(f"{f}=excluded.{f}" for f in FIELDS
                           if f not in ("openalex_id", "first_seen"))
    sql = (f"INSERT INTO papers({','.join(FIELDS)})"
           f" VALUES({','.join('?' * len(FIELDS))})"
           f" ON CONFLICT(openalex_id) DO UPDATE SET {assignments}")
    added = 0
    for r in rows:
        if not r["title"]:
            continue
        record = dict(r)
        record.update({
            "oa_status": "green",          # arXiv is an open repository
            "licence": "arxiv",
            "full_text_reusable": "yes",
            "source": "arxiv",
            "source_queries": query_name,
            "is_preprint": "yes",
            "cited_by_count": 0,
            "citations_per_year": 0.0,
            "fetched_at": now,
            "first_seen": now,
        })
        try:
            conn.execute(sql, [record.get(f) for f in FIELDS])
            added += 1
        except Exception as exc:
            # A DOI already held under an OpenAlex id: the published version
            # is the better record, so the preprint is simply skipped.
            if "UNIQUE" not in str(exc).upper():
                print(f"    could not store {r['openalex_id']}: {exc}",
                      file=sys.stderr)
    conn.commit()
    return added


def main():
    p = argparse.ArgumentParser(description="Collect papers from arXiv.")
    p.add_argument("--db", default=None)
    p.add_argument("--per-search", type=int, default=400,
                   help="how many papers to take from each search")
    p.add_argument("--only", default=None, help="run one search by name")
    p.add_argument("--restart", action="store_true", help="ignore the progress file")
    p.add_argument("--list", action="store_true", help="show the searches and stop")
    args = p.parse_args()

    if args.list:
        for name, query, is_g in SEARCHES:
            print(f"  {name:24} {'graphene' if is_g else 'the field around it':20} {query}")
        return

    searches = [s for s in SEARCHES if not args.only or s[0] == args.only]
    if not searches:
        sys.exit(f"no search called {args.only!r}; --list shows them")

    state = {"done": {}, "started": None} if args.restart else load_progress()
    state["started"] = state.get("started") or datetime.now(timezone.utc).isoformat()
    conn = db.init(args.db)

    print(f"arXiv collection")
    print(f"  searches : {len(searches)}")
    print(f"  per search: up to {args.per_search:,} papers")
    print(f"  pace     : one request every {PAUSE:.0f}s, as arXiv asks\n")

    total_added = 0
    for name, query, _ in searches:
        already = state["done"].get(name, 0)
        if already >= args.per_search:
            print(f"  {name:24} done already ({already:,})")
            continue
        got, start, reported = 0, already, None
        while got + already < args.per_search:
            page = min(PAGE, args.per_search - already - got)
            text = fetch(query, start, page)
            if text is None:
                break
            rows, reported = entries(text)
            if not rows:
                break
            added = store(conn, rows, name)
            got += len(rows)
            start += len(rows)
            total_added += added
            state["done"][name] = already + got
            save_progress(state)
            if start >= (reported or 0):
                break
            time.sleep(PAUSE)
        print(f"  {name:24} {got:5,} fetched"
              f"{'' if reported is None else f'  (arXiv has {reported:,})'}")
        time.sleep(PAUSE)

    held = conn.execute("SELECT count(*) FROM papers WHERE source='arxiv'").fetchone()[0]
    everything = conn.execute("SELECT count(*) FROM papers").fetchone()[0]
    with_abs = conn.execute("SELECT count(*) FROM papers WHERE source='arxiv'"
                            " AND abstract IS NOT NULL AND abstract != ''").fetchone()[0]
    print(f"\n  from arXiv in the library : {held:,} ({with_abs:,} with an abstract)")
    print(f"  papers in the library     : {everything:,}")
    db.log_run(conn, "collect_arxiv", state["started"],
               datetime.now(timezone.utc).isoformat(timespec="seconds"),
               total_added, 0)
    conn.close()


if __name__ == "__main__":
    main()

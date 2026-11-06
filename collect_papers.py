#!/usr/bin/env python3
"""Collect graphene-battery paper metadata from OpenAlex into a CSV.

Phase 1: data collection only. Re-running is safe: rows are merged on the
OpenAlex work id, so the same paper is never written twice.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import tempfile
import time
import urllib.parse
from datetime import datetime, timezone

import requests

API = "https://api.openalex.org/works"

# --- Search definition ------------------------------------------------------
# Title-only search: high precision. Both "graphene" and "battery" must appear
# in the title, the work must be a journal article, published 2019 or later.
FILTERS = (
    "from_publication_date:2019-01-01",
    "type:article",
    "title.search:graphene AND battery",
)
SELECT = (
    "id,doi,title,publication_year,publication_date,type,primary_location,"
    "best_oa_location,open_access,authorships,cited_by_count,"
    "abstract_inverted_index"
)
PER_PAGE = 200
MAX_AUTHORS = 20

COLUMNS = [
    "openalex_id", "doi", "title", "year", "publication_date", "journal",
    "publisher", "type", "authors", "cited_by_count", "citations_per_year",
    "is_oa", "oa_status", "licence", "full_text_reusable", "pdf_url",
    "landing_page_url", "abstract", "retrieved_at",
]

# Licences that permit copying and redistribution of the full text.
LICENCE_REUSABLE = {"cc0", "cc-by", "cc-by-sa", "public-domain", "pd"}
# Open but with terms that restrict reuse (non-commercial / no-derivatives),
# or open with unstated terms.
LICENCE_RESTRICTED = {
    "cc-by-nc", "cc-by-nd", "cc-by-nc-sa", "cc-by-nc-nd",
    "publisher-specific-oa", "other-oa", "publisher-specific-open-access",
}

# Network behaviour
MAX_PAGE_RETRIES = 4
BACKOFF_BASE = 2
MAX_RETRY_AFTER = 120  # seconds; longer than this is a hard failure


# --- Helpers ----------------------------------------------------------------

def load_env(path=".env"):
    """Minimal .env reader. No extra dependency."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def api_key():
    key = os.environ.get("OPENALEX_API_KEY", "").strip()
    if not key:
        sys.exit(
            "ERROR: OPENALEX_API_KEY is not set.\n"
            "  Local: copy .env.example to .env and fill it in.\n"
            "  CI:    set the OPENALEX_API_KEY repository secret."
        )
    return key


def reconstruct_abstract(index):
    """Rebuild abstract text from OpenAlex's inverted index."""
    if not index:
        return ""
    positions = []
    for word, slots in index.items():
        for slot in slots:
            positions.append((slot, word))
    positions.sort()
    return " ".join(word for _, word in positions)


def clean_doi(raw):
    if not raw:
        return ""
    return raw.replace("https://doi.org/", "").replace("http://doi.org/", "").strip()


def classify_reuse(licence, is_oa):
    """Map licence + OA status to a full-text reuse verdict.

    NOTE: OpenAlex licence metadata is incomplete and sometimes wrong.
    'yes' is a lead worth checking, not legal clearance.
    """
    lic = (licence or "").lower().strip()
    if lic in LICENCE_REUSABLE:
        return "yes"
    if lic in LICENCE_RESTRICTED:
        return "restricted"
    if lic:
        parts = set(lic.split("-"))
        if "nc" in parts or "nd" in parts:
            return "restricted"
        return "unknown"
    return "unknown" if is_oa else "no"


def flatten(work, current_year, retrieved_at):
    """Turn one OpenAlex work into one CSV row. Raises on malformed input."""
    primary = work.get("primary_location") or {}
    best_oa = work.get("best_oa_location") or {}
    source = primary.get("source") or {}
    oa = work.get("open_access") or {}

    year = work.get("publication_year")
    year = int(year) if year else ""

    cited = work.get("cited_by_count") or 0
    if year:
        age = max(1, current_year - int(year) + 1)
        cpy = round(cited / age, 2)
    else:
        cpy = ""

    names = []
    for a in (work.get("authorships") or []):
        author = a.get("author") or {}
        name = (author.get("display_name") or "").strip()
        if name:
            names.append(name)
    authors = "; ".join(names[:MAX_AUTHORS])
    if len(names) > MAX_AUTHORS:
        authors += " et al."

    licence = best_oa.get("license") or primary.get("license") or ""
    is_oa = bool(oa.get("is_oa"))

    return {
        "openalex_id": (work.get("id") or "").replace("https://openalex.org/", ""),
        "doi": clean_doi(work.get("doi")),
        "title": (work.get("title") or "").strip(),
        "year": year,
        "publication_date": work.get("publication_date") or "",
        "journal": (source.get("display_name") or "").strip(),
        "publisher": (source.get("host_organization_name") or "").strip(),
        "type": work.get("type") or "",
        "authors": authors,
        "cited_by_count": cited,
        "citations_per_year": cpy,
        "is_oa": "yes" if is_oa else "no",
        "oa_status": oa.get("oa_status") or "",
        "licence": licence,
        "full_text_reusable": classify_reuse(licence, is_oa),
        "pdf_url": best_oa.get("pdf_url") or primary.get("pdf_url") or "",
        "landing_page_url": (
            best_oa.get("landing_page_url") or primary.get("landing_page_url") or ""
        ),
        "abstract": reconstruct_abstract(work.get("abstract_inverted_index")),
        "retrieved_at": retrieved_at,
    }


def fetch_page(session, cursor, key):
    """Fetch one page. Retries transient failures, then fails hard."""
    params = {
        "filter": ",".join(FILTERS),
        "select": SELECT,
        "per-page": str(PER_PAGE),
        "cursor": cursor,
    }
    url = API + "?" + urllib.parse.urlencode(params)
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}

    last = ""
    for attempt in range(1, MAX_PAGE_RETRIES + 1):
        try:
            resp = session.get(url, headers=headers, timeout=60)
        except requests.RequestException as exc:
            last = f"network error: {exc}"
        else:
            if resp.status_code == 200:
                return resp.json()
            last = f"HTTP {resp.status_code}: {resp.text[:200]}"
            if resp.status_code == 429:
                wait = resp.headers.get("Retry-After", "")
                try:
                    wait = int(float(wait))
                except (TypeError, ValueError):
                    wait = BACKOFF_BASE ** attempt
                if wait > MAX_RETRY_AFTER:
                    sys.exit(
                        f"ERROR: rate limited for {wait}s, longer than this run "
                        f"will wait. Nothing written.\n  {last}"
                    )
                time.sleep(wait)
                continue
            if resp.status_code in (401, 403):
                sys.exit(f"ERROR: authentication rejected. Nothing written.\n  {last}")
            if resp.status_code < 500:
                sys.exit(f"ERROR: request rejected. Nothing written.\n  {last}")
        if attempt < MAX_PAGE_RETRIES:
            time.sleep(BACKOFF_BASE ** attempt)

    sys.exit(
        f"ERROR: page failed after {MAX_PAGE_RETRIES} attempts. Nothing written.\n"
        f"  {last}"
    )


def read_existing(path):
    """Load an existing CSV so a re-run merges instead of duplicating."""
    if not path or not os.path.exists(path):
        return {}
    rows = {}
    try:
        with open(path, newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                wid = (row.get("openalex_id") or "").strip()
                if wid:
                    rows[wid] = row
    except OSError as exc:
        sys.exit(f"ERROR: cannot read existing {path}: {exc}")
    return rows


def write_atomic(path, rows):
    """Write to a temp file in the same directory, then rename into place."""
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=parent, prefix=".papers-", suffix=".csv")
    try:
        with os.fdopen(fd, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=COLUMNS, extrasaction="ignore")
            writer.writeheader()
            for row in rows:
                writer.writerow({c: row.get(c, "") for c in COLUMNS})
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


# --- Main -------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Collect graphene-battery paper metadata from OpenAlex."
    )
    parser.add_argument("--out", help="CSV path to write, e.g. data/papers.csv")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Fetch one page, report what would be collected, write nothing.",
    )
    args = parser.parse_args()

    if not args.dry_run and not args.out:
        parser.error("either --out PATH or --dry-run is required")

    load_env()
    key = api_key()

    now = datetime.now(timezone.utc)
    current_year = now.year
    retrieved_at = now.replace(microsecond=0).isoformat()

    print("OpenAlex collection run")
    print(f"  filter      : {','.join(FILTERS)}")
    print(f"  per-page    : {PER_PAGE}")
    print(f"  mode        : {'DRY RUN (writes nothing)' if args.dry_run else 'full'}")
    if not args.dry_run:
        print(f"  output      : {args.out}")
    print(f"  api key     : configured ({len(key)} chars, value not shown)")
    print()

    session = requests.Session()
    session.headers["User-Agent"] = "research-agent/0.1 (Phase 1 collector)"

    page = fetch_page(session, "*", key)
    total = page.get("meta", {}).get("count", 0)
    print(f"Matching works reported by OpenAlex: {total}")
    print(f"Pages to fetch at {PER_PAGE}/page       : {-(-total // PER_PAGE)}")
    print()

    if args.dry_run:
        rows, skipped = [], 0
        for work in page.get("results", []):
            try:
                rows.append(flatten(work, current_year, retrieved_at))
            except Exception:
                skipped += 1
        print(f"First page parsed: {len(rows)} rows, {skipped} skipped")
        print()
        print("Columns:")
        print("  " + ", ".join(COLUMNS))
        print()
        print("Sample of 3 rows:")
        for row in rows[:3]:
            print("  ---")
            print(f"  openalex_id        : {row['openalex_id']}")
            print(f"  doi                : {row['doi'] or '(empty)'}")
            print(f"  title              : {row['title'][:90]}")
            print(f"  year               : {row['year']}")
            print(f"  journal            : {row['journal'][:70] or '(empty)'}")
            print(f"  cited_by_count     : {row['cited_by_count']}")
            print(f"  citations_per_year : {row['citations_per_year']}")
            print(f"  oa_status          : {row['oa_status'] or '(empty)'}")
            print(f"  licence            : {row['licence'] or '(empty)'}")
            print(f"  full_text_reusable : {row['full_text_reusable']}")
            print(f"  pdf_url            : {(row['pdf_url'] or '(empty)')[:70]}")
            print(f"  abstract           : {len(row['abstract'])} chars")
        print()
        print("DRY RUN complete. No file was written.")
        return

    existing = read_existing(args.out)
    print(f"Existing rows loaded for merge: {len(existing)}")

    collected, skipped, pages = {}, 0, 0
    cursor = "*"
    while True:
        if pages:  # first page already fetched
            page = fetch_page(session, cursor, key)
        pages += 1
        results = page.get("results", [])
        for work in results:
            try:
                row = flatten(work, current_year, retrieved_at)
            except Exception as exc:
                skipped += 1
                print(f"  skipped a record: {type(exc).__name__}: {exc}", flush=True)
                continue
            if row["openalex_id"]:
                collected[row["openalex_id"]] = row
            else:
                skipped += 1
        print(f"  page {pages}: +{len(results)} (total {len(collected)})", flush=True)
        cursor = page.get("meta", {}).get("next_cursor")
        if not cursor or not results:
            break

    if not collected:
        sys.exit("ERROR: collected zero rows. Nothing written.")

    merged = dict(existing)
    new_ids = set(collected) - set(existing)
    merged.update(collected)
    rows = sorted(
        merged.values(),
        key=lambda r: (
            -float(r.get("citations_per_year") or 0),
            str(r.get("title", "")),
        ),
    )
    write_atomic(args.out, rows)

    print()
    print(f"Pages fetched    : {pages}")
    print(f"Records skipped  : {skipped}")
    print(f"New this run     : {len(new_ids)}")
    print(f"Updated existing : {len(set(collected) & set(existing))}")
    print(f"Total rows in CSV: {len(rows)}")
    print(f"Written to       : {args.out}")


if __name__ == "__main__":
    main()

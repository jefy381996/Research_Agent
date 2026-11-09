#!/usr/bin/env python3
"""Collect graphene-battery paper metadata from OpenAlex into a CSV.

Ten title-anchored searches cover the sub-domains of graphene battery
research. Results are unioned and de-duplicated on the OpenAlex work id.

Why the work id and not the DOI: a meaningful share of OpenAlex works carry
no DOI. Keying on DOI would collapse every DOI-less paper into a single row.
The DOI is still stored, and `load_papers.py` maps an empty DOI to NULL so a
UNIQUE constraint on the column behaves correctly.

Re-running is safe: existing rows are merged, never duplicated.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import tempfile
import time
import urllib.parse
from datetime import datetime, timezone

import requests

API = "https://api.openalex.org/works"

BASE_FILTERS = ("from_publication_date:2019-01-01", "type:article")

# Ten searches. Each requires a graphene-family term in the title, so a paper
# that merely mentions graphene in passing is not pulled in.
SEARCHES = [
    # Application: graphene in batteries, by sub-domain.
    ("battery",        'title.search:graphene AND (battery OR batteries)', None),
    ("anode",          'title.search:graphene AND (anode OR anodes)', None),
    ("cathode",        'title.search:graphene AND (cathode OR cathodes)', None),
    ("electrode",      'title.search:graphene AND (electrode OR electrodes)', 2500),
    ("graphene-oxide", 'title.search:"graphene oxide" AND (battery OR anode OR cathode)', None),
    ("rgo",            'title.search:("reduced graphene oxide" OR rGO) AND (battery OR anode OR cathode)', None),
    ("lithium-ion",    'title.search:graphene AND ("lithium-ion" OR "lithium ion" OR "Li-ion")', None),
    ("sodium-ion",     'title.search:graphene AND ("sodium-ion" OR "sodium ion" OR "Na-ion")', None),
    ("lithium-sulfur", 'title.search:graphene AND ("lithium-sulfur" OR "lithium sulfur" OR "Li-S")', None),
    ("solid-state",    'title.search:graphene AND ("solid-state" OR "solid state") AND (battery OR electrolyte)', None),
    ("silicon",        'title.search:graphene AND (silicon OR Si) AND (anode OR battery)', None),
    ("supercapacitor", 'title.search:graphene AND (supercapacitor OR supercapacitors OR "energy storage")', 2000),
    ("separator",      'title.search:graphene AND (separator OR interlayer OR "current collector")', None),

    # Fundamentals: what graphene is, how it is made, how it is measured.
    ("synthesis",      'title.search:graphene AND (synthesis OR fabrication OR production OR preparation OR growth)', 2500),
    ("cvd",            'title.search:graphene AND ("chemical vapor deposition" OR CVD OR exfoliation)', None),
    ("properties",     'title.search:graphene AND (properties OR conductivity OR mechanical OR thermal OR electronic)', 2500),
    ("characterisation", 'title.search:graphene AND (Raman OR XPS OR "X-ray diffraction" OR microscopy OR spectroscopy)', None),
    ("reduction",      'title.search:"graphene oxide" AND (reduction OR reduced OR functionalization OR doping)', 2000),
    ("structure",      'title.search:graphene AND (structure OR defects OR edge OR layer OR nanoribbon)', 2000),
    ("review",         'title.search:graphene AND (review OR advances OR progress OR perspective) AND (energy OR battery OR storage)', None),

    # Battery fundamentals, so the library can explain the field graphene sits in.
    ("battery-basics", 'title.search:("lithium-ion battery" OR "lithium ion battery") AND (mechanism OR fundamentals OR review OR degradation OR "solid electrolyte interphase")', 1500),
    ("beyond-lithium", 'title.search:("sodium-ion" OR "potassium-ion" OR "zinc-ion" OR "magnesium") AND (battery OR batteries) AND (anode OR cathode OR electrolyte)', 1500),

    # Graphene beyond energy storage. The tool is about graphene, not only
    # graphene in batteries, so every major application domain is represented.
    ("electronics",    'title.search:graphene AND (transistor OR electronics OR "field-effect" OR circuit OR interconnect)', 1400),
    ("sensors",        'title.search:graphene AND (sensor OR sensors OR sensing OR biosensor OR detection)', 1400),
    ("membranes",      'title.search:graphene AND (membrane OR filtration OR desalination OR "water treatment" OR separation)', 1400),
    ("composites",     'title.search:graphene AND (composite OR composites OR polymer OR reinforcement OR nanocomposite)', 1400),
    ("coatings",       'title.search:graphene AND (coating OR corrosion OR barrier OR anti-corrosion OR tribolog)', 1200),
    ("thermal",        'title.search:graphene AND ("thermal conductivity" OR "heat dissipation" OR "thermal management" OR phonon)', 1200),
    ("photonics",      'title.search:graphene AND (photonic OR optoelectronic OR photodetector OR laser OR plasmonic OR modulator)', 1400),
    ("solar",          'title.search:graphene AND (solar OR photovoltaic OR "perovskite solar" OR "dye-sensitized")', 1200),
    ("catalysis",      'title.search:graphene AND (catalysis OR catalyst OR electrocatalysis OR "oxygen reduction" OR "hydrogen evolution")', 1400),
    ("hydrogen",       'title.search:graphene AND ("hydrogen storage" OR "gas storage" OR adsorption OR "CO2 capture")', 1200),
    ("biomedical",     'title.search:graphene AND (biomedical OR "drug delivery" OR tissue OR antibacterial OR bioimaging OR therapy)', 1400),
    ("toxicity",       'title.search:graphene AND (toxicity OR cytotoxicity OR biocompatibility OR safety OR "environmental impact")', 1000),
    ("mechanical",     'title.search:graphene AND (mechanical OR strength OR elastic OR fracture OR stiffness OR "Young modulus")', 1200),
    ("spintronics",    'title.search:graphene AND (spintronics OR magnetic OR magnetism OR valleytronics OR "spin transport")', 1000),
    ("quantum",        'title.search:graphene AND (quantum OR "quantum Hall" OR superconduct OR topological OR "Dirac fermion")', 1200),
    ("fuelcell",       'title.search:graphene AND ("fuel cell" OR "proton exchange" OR electrolyser OR electrolyzer)', 1000),
    ("shielding",      'title.search:graphene AND ("EMI shielding" OR "electromagnetic" OR microwave OR absorption)', 1000),
    ("printing",       'title.search:graphene AND (ink OR printing OR printable OR flexible OR wearable OR stretchable)', 1200),
    ("production",     'title.search:graphene AND ("large-scale" OR "mass production" OR scalable OR industrial OR "roll-to-roll")', 1000),
    ("metrology",      'title.search:graphene AND (metrology OR standard OR "quality control" OR classification OR characterization)', 1000),
]

# Broad fundamentals searches are capped. OpenAlex returns most-cited first,
# so a cap keeps the papers the field actually reads and drops the long tail,
# which would otherwise triple the corpus for little gain.
SORT = "cited_by_count:desc"

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
    "landing_page_url", "abstract", "is_preprint", "source_queries",
    "retrieved_at",
]

LICENCE_REUSABLE = {"cc0", "cc-by", "cc-by-sa", "public-domain", "pd"}
LICENCE_RESTRICTED = {
    "cc-by-nc", "cc-by-nd", "cc-by-nc-sa", "cc-by-nc-nd",
    "publisher-specific-oa", "other-oa", "publisher-specific-open-access",
}

MAX_PAGE_RETRIES = 4
BACKOFF_BASE = 2
MAX_RETRY_AFTER = 120


def load_env(path=".env"):
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
    if not index:
        return ""
    slots = []
    for word, positions in index.items():
        for pos in positions:
            slots.append((pos, word))
    slots.sort()
    return " ".join(word for _, word in slots)


def clean_doi(raw):
    if not raw:
        return ""
    return (raw.replace("https://doi.org/", "")
               .replace("http://doi.org/", "").strip().lower())


def classify_reuse(licence, is_oa):
    """Licence + OA status -> full-text reuse verdict.

    OpenAlex licence metadata is incomplete and sometimes wrong, so `yes` is a
    lead worth checking rather than legal clearance.
    """
    lic = (licence or "").lower().strip()
    if lic in LICENCE_REUSABLE:
        return "yes"
    if lic in LICENCE_RESTRICTED:
        return "restricted"
    if lic:
        parts = set(lic.split("-"))
        return "restricted" if ("nc" in parts or "nd" in parts) else "unknown"
    return "unknown" if is_oa else "no"


def flatten(work, current_year, retrieved_at, label):
    primary = work.get("primary_location") or {}
    best_oa = work.get("best_oa_location") or {}
    source = primary.get("source") or {}
    oa = work.get("open_access") or {}

    raw_year = work.get("publication_year")
    year = int(raw_year) if raw_year else ""

    cited = work.get("cited_by_count") or 0
    cpy = round(cited / max(1, current_year - int(year) + 1), 2) if year else ""

    names = []
    for a in (work.get("authorships") or []):
        name = ((a.get("author") or {}).get("display_name") or "").strip()
        if name:
            names.append(name)
    authors = "; ".join(names[:MAX_AUTHORS])
    if len(names) > MAX_AUTHORS:
        authors += " et al."

    licence = best_oa.get("license") or primary.get("license") or ""
    is_oa = bool(oa.get("is_oa"))
    wtype = work.get("type") or ""

    return {
        "openalex_id": (work.get("id") or "").replace("https://openalex.org/", ""),
        "doi": clean_doi(work.get("doi")),
        "title": (work.get("title") or "").strip(),
        "year": year,
        "publication_date": work.get("publication_date") or "",
        "journal": (source.get("display_name") or "").strip(),
        "publisher": (source.get("host_organization_name") or "").strip(),
        "type": wtype,
        "authors": authors,
        "cited_by_count": cited,
        "citations_per_year": cpy,
        "is_oa": "yes" if is_oa else "no",
        "oa_status": oa.get("oa_status") or "",
        "licence": licence,
        "full_text_reusable": classify_reuse(licence, is_oa),
        "pdf_url": best_oa.get("pdf_url") or primary.get("pdf_url") or "",
        "landing_page_url": (best_oa.get("landing_page_url")
                             or primary.get("landing_page_url") or ""),
        "abstract": reconstruct_abstract(work.get("abstract_inverted_index")),
        "is_preprint": "yes" if wtype == "preprint" else "no",
        "source_queries": label,
        "retrieved_at": retrieved_at,
    }


def fetch_page(session, query_filter, cursor, key):
    params = {
        "filter": query_filter,
        "select": SELECT,
        "sort": SORT,
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
                    sys.exit(f"ERROR: rate limited for {wait}s. Nothing written.\n  {last}")
                time.sleep(wait)
                continue
            if resp.status_code in (401, 403):
                sys.exit(f"ERROR: authentication rejected. Nothing written.\n  {last}")
            if resp.status_code < 500:
                sys.exit(f"ERROR: request rejected. Nothing written.\n  {last}")
        if attempt < MAX_PAGE_RETRIES:
            time.sleep(BACKOFF_BASE ** attempt)

    sys.exit(f"ERROR: page failed after {MAX_PAGE_RETRIES} attempts. Nothing written.\n  {last}")


def read_existing(path):
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


def run_search(session, label, search, cap, key, current_year, retrieved_at,
               collected, dry_run):
    query_filter = ",".join(BASE_FILTERS + (search,))
    page = fetch_page(session, query_filter, "*", key)
    total = page.get("meta", {}).get("count", 0)
    limit = min(total, cap) if cap else total
    note = f" (taking the {cap} most cited)" if cap and total > cap else ""
    print(f"  [{label}] OpenAlex reports {total} works{note}")
    if dry_run:
        return limit, 0

    pages, skipped, cursor = 0, 0, "*"
    while True:
        if pages:
            page = fetch_page(session, query_filter, cursor, key)
        pages += 1
        results = page.get("results", [])
        for work in results:
            try:
                row = flatten(work, current_year, retrieved_at, label)
            except Exception as exc:
                skipped += 1
                print(f"    skipped a record: {type(exc).__name__}: {exc}", flush=True)
                continue
            wid = row["openalex_id"]
            if not wid:
                skipped += 1
                continue
            if wid in collected:
                prior = collected[wid]["source_queries"]
                if label not in prior.split("|"):
                    collected[wid]["source_queries"] = prior + "|" + label
            else:
                collected[wid] = row
        cursor = page.get("meta", {}).get("next_cursor")
        if not cursor or not results or (cap and pages * PER_PAGE >= cap):
            break
    print(f"    {pages} pages, union now {len(collected)}", flush=True)
    return total, skipped


def main():
    parser = argparse.ArgumentParser(
        description="Collect graphene-battery paper metadata from OpenAlex.")
    parser.add_argument("--out", help="CSV path to write, e.g. data/papers.csv")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report counts per search and write nothing.")
    args = parser.parse_args()
    if not args.dry_run and not args.out:
        parser.error("either --out PATH or --dry-run is required")

    load_env()
    key = api_key()

    now = datetime.now(timezone.utc)
    current_year = now.year
    retrieved_at = now.replace(microsecond=0).isoformat()

    print("OpenAlex collection run")
    print(f"  searches : {len(SEARCHES)}")
    print(f"  base     : {','.join(BASE_FILTERS)}")
    print(f"  mode     : {'DRY RUN (writes nothing)' if args.dry_run else 'full'}")
    print(f"  api key  : configured ({len(key)} chars, value not shown)")
    print()

    session = requests.Session()
    session.headers["User-Agent"] = "research-agent/0.4 (graphene battery evidence)"

    collected, skipped_total, reported = {}, 0, 0
    for label, search, cap in SEARCHES:
        total, skipped = run_search(session, label, search, cap, key, current_year,
                                    retrieved_at, collected, args.dry_run)
        reported += total
        skipped_total += skipped

    print()
    print(f"Sum of per-search counts (with overlap): {reported}")
    if args.dry_run:
        print("DRY RUN complete. No file was written.")
        return

    if not collected:
        sys.exit("ERROR: collected zero rows. Nothing written.")

    existing = read_existing(args.out)
    merged = dict(existing)
    new_ids = set(collected) - set(existing)
    merged.update(collected)
    rows = sorted(merged.values(),
                  key=lambda r: (-float(r.get("citations_per_year") or 0),
                                 str(r.get("title", ""))))
    write_atomic(args.out, rows)

    print(f"Unique papers after de-duplication    : {len(collected)}")
    print(f"Records skipped                       : {skipped_total}")
    print(f"New this run                          : {len(new_ids)}")
    print(f"Updated existing                      : {len(set(collected) & set(existing))}")
    print(f"Total rows in CSV                     : {len(rows)}")
    print(f"Written to                            : {args.out}")


if __name__ == "__main__":
    main()

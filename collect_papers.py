#!/usr/bin/env python3
"""Collect graphene paper metadata from OpenAlex into a CSV.

Two kinds of search run. Most require a graphene-family term in the title, so
the paper is about graphene. The rest, labelled `abs-*`, match the title or the
abstract, which also finds papers that only mention graphene; they are kept
because they carry real measurements, and `source_queries` records which
searches found each paper, so the two are never reported as one number.
Results are unioned and de-duplicated on the OpenAlex work id.

OpenAlex meters requests against a budget. When that budget runs out mid-run
the collector writes what it has and records which searches finished, so the
next run resumes instead of paying for the same pages twice.

Why the work id and not the DOI: a meaningful share of OpenAlex works carry
no DOI. Keying on DOI would collapse every DOI-less paper into a single row.
The DOI is still stored, and `load_papers.py` maps an empty DOI to NULL so a
UNIQUE constraint on the column behaves correctly.

Re-running is safe: existing rows are merged, never duplicated.
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

BASE_FILTERS = ("from_publication_date:2019-01-01", "type:article")

# The title-anchored searches come first: each requires a graphene-family term
# in the title, so the paper is about graphene rather than citing it. The
# `abs-*` searches at the end match the abstract too and deliberately cast
# wider; `source_queries` keeps them distinguishable.
SEARCHES = [
    # Application: graphene in batteries, by sub-domain.
    ("battery",        'title.search:graphene AND (battery OR batteries)', None),
    ("anode",          'title.search:graphene AND (anode OR anodes)', None),
    ("cathode",        'title.search:graphene AND (cathode OR cathodes)', None),
    ("electrode",      'title.search:graphene AND (electrode OR electrodes)', 6000),
    ("graphene-oxide", 'title.search:"graphene oxide" AND (battery OR anode OR cathode)', None),
    ("rgo",            'title.search:("reduced graphene oxide" OR rGO) AND (battery OR anode OR cathode)', None),
    ("lithium-ion",    'title.search:graphene AND ("lithium-ion" OR "lithium ion" OR "Li-ion")', None),
    ("sodium-ion",     'title.search:graphene AND ("sodium-ion" OR "sodium ion" OR "Na-ion")', None),
    ("lithium-sulfur", 'title.search:graphene AND ("lithium-sulfur" OR "lithium sulfur" OR "Li-S")', None),
    ("solid-state",    'title.search:graphene AND ("solid-state" OR "solid state") AND (battery OR electrolyte)', None),
    ("silicon",        'title.search:graphene AND (silicon OR Si) AND (anode OR battery)', None),
    ("supercapacitor", 'title.search:graphene AND (supercapacitor OR supercapacitors OR "energy storage")', 5000),
    ("separator",      'title.search:graphene AND (separator OR interlayer OR "current collector")', None),

    # Fundamentals: what graphene is, how it is made, how it is measured.
    ("synthesis",      'title.search:graphene AND (synthesis OR fabrication OR production OR preparation OR growth)', 6000),
    ("cvd",            'title.search:graphene AND ("chemical vapor deposition" OR CVD OR exfoliation)', None),
    ("properties",     'title.search:graphene AND (properties OR conductivity OR mechanical OR thermal OR electronic)', 6000),
    ("characterisation", 'title.search:graphene AND (Raman OR XPS OR "X-ray diffraction" OR microscopy OR spectroscopy)', None),
    ("reduction",      'title.search:"graphene oxide" AND (reduction OR reduced OR functionalization OR doping)', 5000),
    ("structure",      'title.search:graphene AND (structure OR defects OR edge OR layer OR nanoribbon)', 5000),
    ("review",         'title.search:graphene AND (review OR advances OR progress OR perspective) AND (energy OR battery OR storage)', None),

    # ── the materials graphene is weighed against ───────────────────────
    # A tool that only knows graphene can only answer about graphene, and a
    # researcher comparing it against MXene or molybdenum disulfide has to go
    # somewhere else - which is the moment the tool stops being useful. These
    # ask for no graphene term at all, deliberately. Every row they produce is
    # labelled with the material it was measured on and none of them answers a
    # question about graphene; see NO_GRAPHENE_SEARCHES.
    ("mxene",          'title.search:MXene AND (battery OR supercapacitor OR anode OR electrode)', 2500),
    ("mxene-properties", 'title.search:MXene AND (conductivity OR properties OR shielding)', 1500),
    ("mos2",           'title.search:(MoS2 OR "molybdenum disulfide") AND (anode OR battery OR electrode)', 2500),
    ("dichalcogenide", 'title.search:("transition metal dichalcogenide" OR WS2 OR WSe2 OR MoSe2) AND (energy OR battery OR electrode)', 1500),
    ("boron-nitride",  'title.search:("hexagonal boron nitride" OR "h-BN") AND (thermal OR composite OR dielectric)', 1500),
    ("phosphorene",    'title.search:("black phosphorus" OR phosphorene) AND (anode OR battery OR electrode)', 1200),
    ("silicon-anode",  'title.search:"silicon anode" AND (lithium OR battery OR capacity)', 2500),
    ("hard-carbon",    'title.search:"hard carbon" AND (sodium OR anode OR battery)', 2000),
    ("lfp-cathode",    'title.search:(LiFePO4 OR "lithium iron phosphate") AND (cathode OR battery)', 2000),
    ("nmc-cathode",    'title.search:(NMC OR NCM OR "nickel manganese cobalt") AND (cathode OR battery)', 2000),
    ("solid-electrolyte", 'title.search:"solid electrolyte" AND (battery OR lithium OR conductivity)', 2500),
    ("zinc-ion",       'title.search:"zinc-ion" AND (battery OR cathode OR anode)', 2000),
    ("potassium-ion",  'title.search:"potassium-ion" AND (battery OR anode OR cathode)', 1500),
    ("carbon-nanotube", 'title.search:"carbon nanotube" AND (anode OR battery OR composite OR conductivity)', 2000),

    # Battery fundamentals, so the library can explain the field graphene sits in.
    ("battery-basics", 'title.search:("lithium-ion battery" OR "lithium ion battery") AND (mechanism OR fundamentals OR review OR degradation OR "solid electrolyte interphase")', 3800),
    ("beyond-lithium", 'title.search:("sodium-ion" OR "potassium-ion" OR "zinc-ion" OR "magnesium") AND (battery OR batteries) AND (anode OR cathode OR electrolyte)', 3800),

    # Graphene beyond energy storage. The tool is about graphene, not only
    # graphene in batteries, so every major application domain is represented.
    ("electronics",    'title.search:graphene AND (transistor OR electronics OR "field-effect" OR circuit OR interconnect)', 3500),
    ("sensors",        'title.search:graphene AND (sensor OR sensors OR sensing OR biosensor OR detection)', 3500),
    ("membranes",      'title.search:graphene AND (membrane OR filtration OR desalination OR "water treatment" OR separation)', 3500),
    ("composites",     'title.search:graphene AND (composite OR composites OR polymer OR reinforcement OR nanocomposite)', 3500),
    ("coatings",       'title.search:graphene AND (coating OR corrosion OR barrier OR anti-corrosion OR tribolog)', 3000),
    ("thermal",        'title.search:graphene AND ("thermal conductivity" OR "heat dissipation" OR "thermal management" OR phonon)', 3000),
    ("photonics",      'title.search:graphene AND (photonic OR optoelectronic OR photodetector OR laser OR plasmonic OR modulator)', 3500),
    ("solar",          'title.search:graphene AND (solar OR photovoltaic OR "perovskite solar" OR "dye-sensitized")', 3000),
    ("catalysis",      'title.search:graphene AND (catalysis OR catalyst OR electrocatalysis OR "oxygen reduction" OR "hydrogen evolution")', 3500),
    ("hydrogen",       'title.search:graphene AND ("hydrogen storage" OR "gas storage" OR adsorption OR "CO2 capture")', 3000),
    ("biomedical",     'title.search:graphene AND (biomedical OR "drug delivery" OR tissue OR antibacterial OR bioimaging OR therapy)', 3500),
    ("toxicity",       'title.search:graphene AND (toxicity OR cytotoxicity OR biocompatibility OR safety OR "environmental impact")', 2500),
    ("mechanical",     'title.search:graphene AND (mechanical OR strength OR elastic OR fracture OR stiffness OR "Young modulus")', 3000),
    ("spintronics",    'title.search:graphene AND (spintronics OR magnetic OR magnetism OR valleytronics OR "spin transport")', 2500),
    ("quantum",        'title.search:graphene AND (quantum OR "quantum Hall" OR superconduct OR topological OR "Dirac fermion")', 3000),
    ("fuelcell",       'title.search:graphene AND ("fuel cell" OR "proton exchange" OR electrolyser OR electrolyzer)', 2500),
    ("shielding",      'title.search:graphene AND ("EMI shielding" OR "electromagnetic" OR microwave OR absorption)', 2500),
    ("printing",       'title.search:graphene AND (ink OR printing OR printable OR flexible OR wearable OR stretchable)', 3000),
    ("production",     'title.search:graphene AND ("large-scale" OR "mass production" OR scalable OR industrial OR "roll-to-roll")', 2500),
    ("metrology",      'title.search:graphene AND (metrology OR standard OR "quality control" OR classification OR characterization)', 2500),

    # Everything above searches titles only, which is precise and narrow: a
    # paper reporting a graphene membrane may name it only in the abstract.
    # These read the abstract too, and carry the larger share of the corpus.
    # OpenAlex sorts by citations, so a cap takes the papers the field reads.
    ("abs-core",       'title_and_abstract.search:graphene', 20000),
    ("abs-oxide",      'title_and_abstract.search:"graphene oxide"', 9000),
    ("abs-energy",     'title_and_abstract.search:graphene AND (battery OR anode OR cathode OR supercapacitor OR "energy storage")', 9000),
    ("abs-composite",  'title_and_abstract.search:graphene AND (composite OR polymer OR nanocomposite OR filler)', 7000),
    ("abs-electronic", 'title_and_abstract.search:graphene AND (transistor OR electronic OR photonic OR optoelectronic OR device)', 6000),
    ("abs-sensing",    'title_and_abstract.search:graphene AND (sensor OR sensing OR biosensor OR detection)', 6000),
    ("abs-thermal",    'title_and_abstract.search:graphene AND (thermal OR "heat transfer" OR phonon OR "thermal conductivity")', 6000),
    ("abs-membrane",   'title_and_abstract.search:graphene AND (membrane OR filtration OR desalination OR permeation)', 5000),
    ("abs-catalysis",  'title_and_abstract.search:graphene AND (catalyst OR catalysis OR electrocatalyst OR "oxygen reduction")', 5000),
    ("abs-mechanical", 'title_and_abstract.search:graphene AND (mechanical OR strength OR modulus OR fracture OR tensile)', 5000),
    ("abs-bio",        'title_and_abstract.search:graphene AND (biomedical OR drug OR cell OR tissue OR toxicity OR antibacterial)', 5000),
    ("abs-synthesis",  'title_and_abstract.search:graphene AND (synthesis OR growth OR exfoliation OR "chemical vapor deposition")', 6000),
    ("abs-2d",         'title_and_abstract.search:("two-dimensional material" OR "2D material" OR MXene OR "transition metal dichalcogenide") AND graphene', 4000),
    ("abs-coating",    'title_and_abstract.search:graphene AND (coating OR corrosion OR barrier OR lubricant OR tribology)', 4000),
    ("abs-shielding",  'title_and_abstract.search:graphene AND (shielding OR electromagnetic OR microwave OR absorber)', 3000),
    ("abs-printing",   'title_and_abstract.search:graphene AND (ink OR printing OR flexible OR wearable OR stretchable)', 4000),
    ("abs-quantum",    'title_and_abstract.search:graphene AND (quantum OR superconduct OR topological OR "Dirac" OR spin)', 4000),
    ("abs-solar",      'title_and_abstract.search:graphene AND (solar OR photovoltaic OR perovskite OR "light harvesting")', 4000),
    ("abs-hydrogen",   'title_and_abstract.search:graphene AND (hydrogen OR "fuel cell" OR adsorption OR "gas separation")', 4000),
    ("abs-environment",'title_and_abstract.search:graphene AND (adsorbent OR "water treatment" OR "heavy metal" OR dye OR pollutant)', 4000),
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

CHECKPOINT_EVERY = 5            # searches between partial writes
DEFAULT_PROGRESS = "data/.collect-progress.json"

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
    """The key is an optimisation, not a requirement.

    OpenAlex serves this data to anonymous clients; a key buys a higher rate
    limit and a more generous pool, nothing else. Refusing to run without one
    made the collector stricter than the service it calls, so it now says what
    it is doing and carries on.
    """
    key = os.environ.get("OPENALEX_API_KEY", "").strip()
    if not key:
        print("  note     : no OPENALEX_API_KEY set; using the anonymous pool,\n"
              "             which is slower. Set one to collect faster.")
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


class CollectionStopped(RuntimeError):
    """OpenAlex stopped serving this run.

    Raised instead of exiting, so whatever has already been collected is
    written out and the searches that finished are recorded. Twenty minutes of
    paging is not thrown away because the last request was refused.
    """


def fetch_page(session, query_filter, cursor, key):
    params = {
        "filter": query_filter,
        "select": SELECT,
        "sort": SORT,
        "per-page": str(PER_PAGE),
        "cursor": cursor,
    }
    url = API + "?" + urllib.parse.urlencode(params)
    headers = {"Accept": "application/json",
               "User-Agent": "graphene-research-agent/1.0"}
    if key:
        headers["Authorization"] = f"Bearer {key}"

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
                    raise CollectionStopped(
                        f"OpenAlex asked us to wait {wait}s "
                        f"({wait / 3600:.1f} hours), which is longer than this "
                        f"run can sensibly sleep.\n  {last}")
                time.sleep(wait)
                continue
            if resp.status_code in (401, 403):
                raise CollectionStopped(
                    f"OpenAlex rejected our credentials.\n  {last}")
            if resp.status_code < 500:
                raise CollectionStopped(
                    f"OpenAlex rejected the request.\n  {last}")
        if attempt < MAX_PAGE_RETRIES:
            time.sleep(BACKOFF_BASE ** attempt)

    raise CollectionStopped(
        f"a page failed after {MAX_PAGE_RETRIES} attempts.\n  {last}")


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


def load_progress(path):
    """Labels of searches that finished in an earlier run."""
    if not path or not os.path.exists(path):
        return set()
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return set(data.get("done") or [])
    except (OSError, ValueError) as exc:
        print(f"  note     : ignoring unreadable progress file ({exc})")
        return set()


def save_progress(path, done):
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"done": sorted(done),
                       "saved_at": datetime.now(timezone.utc)
                       .replace(microsecond=0).isoformat()}, fh, indent=1)
    except OSError as exc:
        print(f"  warning  : could not save progress ({exc})")


def clear_progress(path):
    try:
        if path and os.path.exists(path):
            os.unlink(path)
    except OSError:
        pass


def merge_and_write(out, collected):
    """Union what this run collected with whatever the CSV already held.

    The CSV is the durable accumulator: a run that stops early writes through
    here, and the next run reads it back, so progress survives a budget that
    runs out mid-way.
    """
    existing = read_existing(out)
    merged = dict(existing)
    merged.update(collected)
    rows = sorted(merged.values(),
                  key=lambda r: (-float(r.get("citations_per_year") or 0),
                                 str(r.get("title", ""))))
    write_atomic(out, rows)
    return rows, existing


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
    parser.add_argument("--progress", default=DEFAULT_PROGRESS,
                        help="where to record which searches finished, so an "
                             "interrupted run resumes instead of re-paying "
                             "for the same pages")
    parser.add_argument("--restart", action="store_true",
                        help="ignore any recorded progress and run every "
                             "search again")
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

    if args.restart and not args.dry_run:
        clear_progress(args.progress)
    done = set() if args.dry_run else load_progress(args.progress)
    if done:
        print(f"  resuming : {len(done)} of {len(SEARCHES)} searches already "
              f"done in an earlier run; skipping them")
    print()

    collected, skipped_total, reported = {}, 0, 0
    stopped, finished = None, 0
    for label, search, cap in SEARCHES:
        if label in done:
            continue
        try:
            total, skipped = run_search(session, label, search, cap, key,
                                        current_year, retrieved_at, collected,
                                        args.dry_run)
        except CollectionStopped as exc:
            stopped = str(exc)
            break
        reported += total
        skipped_total += skipped
        done.add(label)
        finished += 1
        # Partial writes, so a budget that runs out costs one interval of
        # paging rather than the whole run.
        if not args.dry_run and finished % CHECKPOINT_EVERY == 0:
            rows, _ = merge_and_write(args.out, collected)
            save_progress(args.progress, done)
            print(f"    checkpoint: {len(rows)} rows on disk, "
                  f"{len(done)}/{len(SEARCHES)} searches done", flush=True)

    print()
    print(f"Sum of per-search counts (with overlap): {reported}")
    if args.dry_run:
        if stopped:
            sys.exit(f"DRY RUN STOPPED after {len(done)}/{len(SEARCHES)} "
                     f"searches: {stopped}")
        print("DRY RUN complete. No file was written.")
        return

    if not collected:
        if stopped:
            save_progress(args.progress, done)
            sys.exit(f"STOPPED before any new rows were collected: {stopped}\n"
                     f"  {len(done)}/{len(SEARCHES)} searches recorded as done; "
                     f"re-run to resume.")
        if len(done) >= len(SEARCHES):
            # A previous run finished every search but was killed before it
            # could clear the record. There is nothing left to pay for.
            clear_progress(args.progress)
            print(f"All {len(SEARCHES)} searches were already done in an "
                  f"earlier run; nothing to collect.")
            print(f"  {args.out} is left as it is. Use --restart to collect "
                  f"the whole set again.")
            return
        sys.exit("ERROR: collected zero rows. Nothing written.")

    rows, existing = merge_and_write(args.out, collected)
    new_ids = set(collected) - set(existing)

    print(f"Unique papers this run                : {len(collected)}")
    print(f"Records skipped                       : {skipped_total}")
    print(f"New this run                          : {len(new_ids)}")
    print(f"Updated existing                      : {len(set(collected) & set(existing))}")
    print(f"Total rows in CSV                     : {len(rows)}")
    print(f"Searches completed                    : {len(done)}/{len(SEARCHES)}")

    if stopped:
        save_progress(args.progress, done)
        sys.exit(f"\nSTOPPED EARLY: {stopped}\n"
                 f"  {len(rows)} rows were written to {args.out} and "
                 f"{len(done)}/{len(SEARCHES)} searches recorded as done.\n"
                 f"  Re-run the same command to resume from search "
                 f"{len(done) + 1}; nothing already paid for is fetched twice.")
    clear_progress(args.progress)
    print(f"Written to                            : {args.out}")


if __name__ == "__main__":
    main()

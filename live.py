"""Reach beyond the stored snapshot.

The library is a snapshot. A researcher asking about something published last
month, or about a corner the collection searches never covered, gets told it
is not in the library - which is honest but not useful.

This queries OpenAlex at question time, runs the same deterministic extractor
over whatever comes back, and returns the findings marked plainly as live:
fetched now, not yet part of the checked corpus. Nothing is written to the
database by answering a question; promoting a live result into the library is
a separate, deliberate step.
"""

from __future__ import annotations

import os
import time
import urllib.parse
from datetime import datetime, timezone

import requests

import collect_papers as CP
import db
import extract_evidence as EX
import plausibility

API = "https://api.openalex.org/works"
SELECT = ("id,doi,title,publication_year,publication_date,type,primary_location,"
          "best_oa_location,open_access,authorships,cited_by_count,"
          "abstract_inverted_index")
TIMEOUT = 30
CACHE_TTL = 900          # seconds; the same question twice does not pay twice
_cache: dict[str, tuple[float, dict]] = {}


def _key() -> str | None:
    key = os.environ.get("OPENALEX_API_KEY", "").strip()
    return key or None


def _clean(term: str) -> str:
    """Keep the words, drop anything that would break the filter syntax."""
    out = "".join(c if (c.isalnum() or c in " -_") else " " for c in term)
    return " ".join(out.split())[:120]


def search(question: str, limit: int = 25, since: int = 2019,
           timeout: int = TIMEOUT) -> dict:
    """Fetch recent work matching the question and extract what it states.

    Returns a dict the caller can show directly. `available` is False with a
    stated reason when the lookup cannot run, so the interface can say why
    rather than silently returning nothing.
    """
    # Drop bare years and noise words: a strict field filter ANDs every term,
    # so one stray token ("2025") returns nothing at all.
    terms = [t for t in EX.normalise(question).split()
             if len(t) > 2 and t.lower() not in _STOP and not t.isdigit()]
    query = _clean(" ".join(terms[:8]))
    if not query:
        return {"available": False, "reason": "the question has nothing to search for",
                "papers": [], "rows": []}

    key = _key()
    if not key:
        return {"available": False,
                "reason": "live lookup needs OPENALEX_API_KEY on the server",
                "papers": [], "rows": []}

    hit = _cache.get(query)
    now = time.time()
    if hit and now - hit[0] < CACHE_TTL:
        return hit[1]

    # Relevance search rather than a field filter. A filter requires every
    # term; `search` ranks by how well a work matches and still returns the
    # near misses a researcher wants to see.
    params = {
        "search": query,
        "filter": f"from_publication_date:{since}-01-01,type:article",
        "select": SELECT,
        "per-page": str(min(limit, 50)),
    }
    url = API + "?" + urllib.parse.urlencode(params)
    try:
        response = requests.get(
            url, timeout=timeout,
            headers={"Authorization": f"Bearer {key}", "Accept": "application/json",
                     "User-Agent": "research-agent/1.0 (live lookup)"})
    except requests.RequestException as exc:
        return {"available": False, "reason": f"OpenAlex unreachable: {type(exc).__name__}",
                "papers": [], "rows": []}
    if response.status_code != 200:
        return {"available": False,
                "reason": f"OpenAlex returned {response.status_code}",
                "papers": [], "rows": []}

    current_year = datetime.now(timezone.utc).year
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")

    known = _known_ids()
    papers, rows, failed = [], [], 0
    reasons: dict[str, int] = {}

    def note(exc):
        """Count why a record was dropped. A bare counter hid a plain
        AttributeError here through three runs; the reason is kept now."""
        nonlocal failed
        failed += 1
        label = f"{type(exc).__name__}: {str(exc)[:70]}"
        reasons[label] = reasons.get(label, 0) + 1

    for work in response.json().get("results", []):
        try:
            flat = CP.flatten(work, current_year, stamp, "live")
        except Exception as exc:    # one bad record never fails the lookup
            note(exc)
            continue
        if not flat["openalex_id"]:
            continue
        flat["already_in_library"] = flat["openalex_id"] in known
        papers.append(flat)
        if not flat["abstract"]:
            continue
        try:
            found, _ = EX.rows_for_paper(
                {"openalex_id": flat["openalex_id"], "title": flat["title"],
                 "abstract": flat["abstract"]}, section="abstract (live)")
        except Exception as exc:
            note(exc)
            continue
        for row in found:
            row.pop("_derived", None)
            row.update({"title": flat["title"], "year": flat["year"],
                        "journal": flat["journal"], "doi": flat["doi"],
                        "live": True,
                        "already_in_library": flat["already_in_library"]})
            rows.append(row)

    plausibility.assess(rows)
    result = {
        "available": True,
        "query": query,
        "fetched_at": stamp,
        "papers": papers,
        "rows": rows,
        "new_to_library": sum(1 for p in papers if not p["already_in_library"]),
        "records_failed": failed,
        "failure_reasons": reasons,
        "note": ("Fetched from OpenAlex just now and read with the same extractor. "
                 "These have not been through the library's checks and are not "
                 "stored; treat them as a lead."),
    }
    _cache[query] = (now, result)
    return result


def _known_ids() -> set[str]:
    try:
        conn = db.connect()
    except Exception:
        return set()
    try:
        return {r[0] for r in conn.execute("SELECT openalex_id FROM papers")}
    finally:
        conn.close()


_STOP = {
    "the", "and", "for", "are", "with", "from", "about", "their", "there",
    "that", "this", "can", "what", "which", "how", "does", "did", "was",
    "were", "been", "have", "has", "had", "will", "would", "should", "could",
    "any", "all", "its", "into", "than", "then", "when", "where", "who",
    "whose", "why", "you", "your", "our", "but", "not", "get", "gets",
    "tell", "show", "give", "find", "please", "best", "good", "new",
}

#!/usr/bin/env python3
"""Download full text for papers whose licence permits it, extract, delete.

No PDF is ever stored. Each file is written to a temporary directory, read with
PyMuPDF, and removed in a finally block that runs even on failure. Only papers
with full_text_reusable='yes' (CC BY, CC BY-SA, CC0, public domain) are
fetched, and only the sections worth extracting numbers from are kept:
abstract, results and discussion, and table captions. Introduction, methods
and references are discarded.

One failure never stops the run. Every failure reason is counted and written to
run_log so the top reasons can be reported.

Network note: publisher hosts must be reachable. In a restricted environment
the run reports each refusal as a failure reason rather than crashing, and the
rest of the pipeline continues to work from abstracts alone.
"""

from __future__ import annotations

import argparse
import os
import re
import tempfile
from collections import Counter
from datetime import datetime, timezone

import requests

import db

TIMEOUT = 45
MAX_BYTES = 80 * 1024 * 1024
USER_AGENT = "research-agent/1.0 (graphene battery evidence; licence-respecting)"

SECTION_PATTERNS = [
    ("results", r"^\s*(?:\d+\.?\s*)?(results?\s+and\s+discussions?|results?|"
                r"discussions?)\s*$"),
    ("conclusion", r"^\s*(?:\d+\.?\s*)?(conclusions?|summary)\s*$"),
]
STOP_PATTERNS = r"^\s*(?:\d+\.?\s*)?(references?|bibliography|acknowledge?ments?|" \
                r"supporting\s+information|supplementary)\s*$"
SKIP_PATTERNS = r"^\s*(?:\d+\.?\s*)?(introduction|experimental|methods?|" \
                r"materials?\s+and\s+methods?)\s*$"
TABLE_CAPTION = re.compile(r"^\s*(table|tab\.)\s*\d+[.:]?\s+\S", re.I)


def split_sections(text: str) -> dict[str, str]:
    """Keep results, discussion, conclusions and table captions."""
    lines = text.splitlines()
    kept: dict[str, list[str]] = {"results": [], "tables": []}
    current = None
    for line in lines:
        stripped = line.strip()
        if TABLE_CAPTION.match(stripped):
            kept["tables"].append(stripped)
            continue
        if re.match(STOP_PATTERNS, stripped, re.I):
            current = None
            continue
        if re.match(SKIP_PATTERNS, stripped, re.I):
            current = None
            continue
        matched = None
        for name, pattern in SECTION_PATTERNS:
            if re.match(pattern, stripped, re.I):
                matched = name
                break
        if matched:
            current = "results"
            continue
        if current and stripped:
            kept[current].append(stripped)
    return {k: "\n".join(v).strip() for k, v in kept.items() if v}


def fetch_pdf(session, url):
    response = session.get(url, timeout=TIMEOUT, stream=True,
                           headers={"User-Agent": USER_AGENT})
    response.raise_for_status()
    kind = (response.headers.get("Content-Type") or "").lower()
    if "pdf" not in kind and not url.lower().endswith(".pdf"):
        raise ValueError(f"not a PDF (content-type {kind or 'unknown'})")
    size, chunks = 0, []
    for chunk in response.iter_content(65536):
        size += len(chunk)
        if size > MAX_BYTES:
            raise ValueError("PDF larger than the size limit")
        chunks.append(chunk)
    return b"".join(chunks)


def extract(raw: bytes) -> tuple[str, int]:
    """Write, read, delete. The PDF never outlives this function."""
    import pymupdf
    directory = tempfile.mkdtemp(prefix="fulltext-")
    path = os.path.join(directory, "paper.pdf")
    try:
        with open(path, "wb") as handle:
            handle.write(raw)
        document = pymupdf.open(path)
        try:
            pages = document.page_count
            return "\n".join(page.get_text() for page in document), pages
        finally:
            document.close()
    finally:
        if os.path.exists(path):
            os.unlink(path)
        if os.path.isdir(directory):
            os.rmdir(directory)


def main():
    parser = argparse.ArgumentParser(
        description="Fetch and store full text for reusable papers.")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--db", default=None)
    args = parser.parse_args()

    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn = db.init(args.db)

    sql = ("SELECT openalex_id, pdf_url, title FROM papers"
           " WHERE full_text_reusable='yes' AND pdf_url IS NOT NULL"
           " AND pdf_url != ''"
           " AND openalex_id NOT IN (SELECT openalex_id FROM paper_sections"
           "                          WHERE section IN ('results','tables'))"
           " ORDER BY citations_per_year DESC")
    if args.limit:
        sql += f" LIMIT {int(args.limit)}"
    papers = conn.execute(sql).fetchall()
    print(f"Papers licensed for full text and not yet stored: {len(papers)}")

    session = requests.Session()
    stored = failed = 0
    lengths = []
    reasons = Counter()

    for paper in papers:
        try:
            raw = fetch_pdf(session, paper["pdf_url"])
            text, pages = extract(raw)
            if not text.strip():
                raise ValueError("no text layer (likely a scanned PDF)")
            sections = split_sections(text)
            if not sections:
                raise ValueError("no results or table sections found")
            for name, content in sections.items():
                conn.execute(
                    "INSERT INTO paper_sections(openalex_id, section, content)"
                    " VALUES(?,?,?) ON CONFLICT(openalex_id, section)"
                    " DO UPDATE SET content=excluded.content",
                    (paper["openalex_id"], name, content))
            conn.commit()
            stored += 1
            lengths.append(sum(len(v) for v in sections.values()))
            print(f"  stored {paper['openalex_id']} ({pages} pages)", flush=True)
        except Exception as exc:          # one paper never stops the run
            failed += 1
            reason = f"{type(exc).__name__}: {str(exc)[:90]}"
            reasons[reason] += 1

    finished = datetime.now(timezone.utc).isoformat(timespec="seconds")
    db.log_run(conn, "fetch_text", started, finished, stored, 0,
               [{"reason": r, "count": n} for r, n in reasons.most_common(50)])

    print()
    print(f"Papers with stored text : {stored}")
    print(f"Failures                : {failed}")
    if lengths:
        print(f"Average stored length   : {sum(lengths) // len(lengths)} characters")
    if reasons:
        print("Top extraction failure reasons:")
        for reason, count in reasons.most_common(10):
            print(f"  {count:5}  {reason}")
    conn.close()


if __name__ == "__main__":
    main()

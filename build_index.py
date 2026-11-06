#!/usr/bin/env python3
"""Split paper text into overlapping chunks and index them for search.

Abstracts become `paper_sections` rows; `fetch_text.py` adds results and table
captions for papers whose licence allows it. Chunks are ~500 words with 50
words of overlap, so a sentence near a boundary is still findable. The FTS5
index is maintained by triggers, so re-running only touches what changed.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone

import db

CHUNK_WORDS = 500
OVERLAP_WORDS = 50


def chunk(text: str, size: int = CHUNK_WORDS, overlap: int = OVERLAP_WORDS):
    words = text.split()
    if not words:
        return []
    if len(words) <= size:
        return [" ".join(words)]
    out, start = [], 0
    step = size - overlap
    while start < len(words):
        out.append(" ".join(words[start:start + size]))
        if start + size >= len(words):
            break
        start += step
    return out


def main():
    parser = argparse.ArgumentParser(description="Chunk and index paper text.")
    parser.add_argument("--db", default=None)
    parser.add_argument("--rebuild", action="store_true",
                        help="drop existing chunks before indexing")
    args = parser.parse_args()

    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn = db.init(args.db)

    # Abstracts become sections. Idempotent: the unique key is (paper, section).
    moved = conn.execute("""
        INSERT INTO paper_sections(openalex_id, section, content)
        SELECT openalex_id, 'abstract', abstract FROM papers
        WHERE abstract IS NOT NULL AND abstract != ''
        ON CONFLICT(openalex_id, section) DO UPDATE SET content=excluded.content
    """).rowcount
    conn.commit()
    print(f"paper_sections upserted from abstracts: {moved}")

    if args.rebuild:
        conn.execute("DELETE FROM chunks")
        conn.commit()
        print("existing chunks dropped")

    sections = conn.execute(
        "SELECT openalex_id, section, content FROM paper_sections").fetchall()
    added, failed = 0, 0
    for row in sections:
        try:
            for ordinal, piece in enumerate(chunk(row["content"])):
                conn.execute(
                    "INSERT INTO chunks(openalex_id, section, ordinal, text)"
                    " VALUES(?,?,?,?)"
                    " ON CONFLICT(openalex_id, section, ordinal)"
                    " DO UPDATE SET text=excluded.text",
                    (row["openalex_id"], row["section"], ordinal, piece))
                added += 1
        except Exception:                      # one section never stops the run
            failed += 1
    conn.commit()

    # Keep the FTS index consistent after upserts.
    conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")
    conn.commit()

    total_chunks = conn.execute("SELECT count(*) FROM chunks").fetchone()[0]
    finished = datetime.now(timezone.utc).isoformat(timespec="seconds")
    db.log_run(conn, "build_index", started, finished, added, 0,
               [{"sections_failed": failed}] if failed else [])
    print(f"chunks written : {added}")
    print(f"sections failed: {failed}")
    print(f"total chunks   : {total_chunks}")
    conn.close()


if __name__ == "__main__":
    main()

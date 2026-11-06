"""Retrieval over the indexed corpus. No AI in this file.

FTS5 with BM25 ranking, plus a small domain synonym expansion so that a
question phrased as "Li-S cycling" still reaches text that says
"lithium-sulfur capacity retention". Scores from the text index and from
structured evidence matches are combined so a question about a number can
surface the row that holds it.
"""

from __future__ import annotations

import re

import db

# Domain synonyms. Expansion widens recall; it never invents an answer.
SYNONYMS = {
    "capacity": ["mAh", "mAh/g", "specific capacity", "gravimetric capacity"],
    "retention": ["retained", "capacity retention", "cycling stability"],
    "cycling": ["cycles", "cycle life", "cyclability", "long-term"],
    "rate": ["C-rate", "rate capability", "current density"],
    "li-s": ["lithium-sulfur", "lithium sulfur", "Li2S", "sulfur cathode"],
    "lib": ["lithium-ion", "lithium ion battery"],
    "sib": ["sodium-ion", "sodium ion battery"],
    "zib": ["zinc-ion", "zinc ion battery"],
    "rgo": ["reduced graphene oxide", "graphene oxide"],
    "go": ["graphene oxide"],
    "anode": ["negative electrode"],
    "cathode": ["positive electrode"],
    "efficiency": ["coulombic efficiency", "ICE"],
    "silicon": ["Si", "SiOx", "silicon anode"],
    "conductivity": ["electrical conductivity", "ionic conductivity"],
    "dendrite": ["dendrites", "lithium plating"],
}

STOPWORDS = {
    "the", "a", "an", "of", "for", "and", "or", "in", "on", "to", "is", "are",
    "what", "which", "how", "does", "do", "with", "by", "at", "be", "best",
    "can", "that", "this", "it", "as", "from", "about", "there", "their",
}


def _terms(question: str) -> list[str]:
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9\-/]{1,}", question.lower())
    return [w for w in words if w not in STOPWORDS and len(w) > 1]


def build_fts_query(question: str) -> str:
    """An FTS5 MATCH expression: OR over terms and their synonyms."""
    parts = []
    for term in _terms(question):
        group = [term] + SYNONYMS.get(term, [])
        quoted = [f'"{g}"' for g in group]
        parts.append("(" + " OR ".join(quoted) + ")")
    if not parts:
        return ""
    return " OR ".join(parts)


def search(question: str, limit: int = 10, conn=None) -> list[dict]:
    """Top chunks for a question, best first.

    Returns a list of dicts carrying the chunk text, its paper, and the score.
    An empty list means the library has nothing, which the caller must respect
    rather than fill in.
    """
    own = conn is None
    conn = conn or db.connect()
    try:
        match = build_fts_query(question)
        if not match:
            return []
        rows = conn.execute("""
            SELECT c.id, c.openalex_id, c.section, c.text,
                   bm25(chunks_fts) AS bm,
                   p.title, p.year, p.journal, p.doi, p.citations_per_year
            FROM chunks_fts
            JOIN chunks c ON c.id = chunks_fts.rowid
            JOIN papers p ON p.openalex_id = c.openalex_id
            WHERE chunks_fts MATCH ?
            ORDER BY bm
            LIMIT ?
        """, (match, limit * 4)).fetchall()

        terms = set(_terms(question))
        out = []
        for row in rows:
            text_low = row["text"].lower()
            overlap = sum(1 for t in terms if t in text_low)
            coverage = overlap / max(1, len(terms))
            # bm25 is negative, more negative is better.
            score = (-row["bm"]) * 0.6 + coverage * 10.0 \
                + min(row["citations_per_year"] or 0, 40) * 0.05
            out.append({
                "chunk_id": row["id"],
                "openalex_id": row["openalex_id"],
                "section": row["section"],
                "text": row["text"],
                "title": row["title"],
                "year": row["year"],
                "journal": row["journal"],
                "doi": row["doi"],
                "score": round(score, 3),
                "term_coverage": round(coverage, 3),
            })
        out.sort(key=lambda r: -r["score"])
        return out[:limit]
    finally:
        if own:
            conn.close()


def search_evidence(question: str, limit: int = 40, conn=None) -> list[dict]:
    """Evidence rows ranked by how many query terms they match.

    Ranking rather than filtering: an OR across every term would match any row
    whose quote happens to contain a common word like "capacity".
    """
    own = conn is None
    conn = conn or db.connect()
    try:
        terms = _terms(question)
        if not terms:
            return []
        score_parts, params = [], []
        for term in terms:
            like = f"%{term}%"
            score_parts.append(
                "(CASE WHEN lower(coalesce(e.material_system,'')) LIKE ? THEN 3"
                " WHEN lower(coalesce(e.battery_type,'')) LIKE ? THEN 2"
                " WHEN lower(coalesce(e.graphene_form,'')) LIKE ? THEN 2"
                " WHEN lower(coalesce(e.electrode_role,'')) LIKE ? THEN 2"
                " WHEN lower(e.source_quote) LIKE ? THEN 1 ELSE 0 END)")
            params += [like, like, like, like, like]
        expr = " + ".join(score_parts)
        sql = f"""
            SELECT e.*, p.title, p.year, p.journal, p.doi,
                   ({expr}) AS match_score
            FROM evidence e JOIN papers p ON p.openalex_id = e.openalex_id
            WHERE ({expr}) >= 2
            ORDER BY match_score DESC,
                     (e.confidence = 'verified') DESC,
                     e.specific_capacity_mah_g DESC
            LIMIT ?
        """
        return [dict(r) for r in conn.execute(sql, params + params + [limit])]
    finally:
        if own:
            conn.close()


def filter_evidence(material=None, graphene_form=None, battery_type=None,
                    electrode_role=None, limit=400, conn=None) -> list[dict]:
    """Evidence rows matching structured facets, best-measured first."""
    own = conn is None
    conn = conn or db.connect()
    try:
        clauses, params = ["1=1"], []
        if material:
            clauses.append("lower(e.material_system) LIKE ?")
            params.append(f"%{material.lower()}%")
        if graphene_form:
            clauses.append("lower(e.graphene_form) = ?")
            params.append(graphene_form.lower())
        if battery_type:
            clauses.append("lower(e.battery_type) = ?")
            params.append(battery_type.lower())
        if electrode_role:
            clauses.append("lower(e.electrode_role) = ?")
            params.append(electrode_role.lower())
        sql = f"""
            SELECT e.*, p.title, p.year, p.journal, p.doi
            FROM evidence e JOIN papers p ON p.openalex_id = e.openalex_id
            WHERE {' AND '.join(clauses)}
            ORDER BY (e.confidence='verified') DESC,
                     e.specific_capacity_mah_g DESC
            LIMIT ?
        """
        params.append(limit)
        return [dict(r) for r in conn.execute(sql, params)]
    finally:
        if own:
            conn.close()

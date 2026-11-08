"""Answer a question using only what is in the library.

The answer is a quantitative synthesis, not a paraphrase. For a question about
a performance figure the engine finds the matching evidence rows, reports the
spread across them, and cites the sentence behind each number. For anything
else it falls back to the indexed text.

Rule 4 of the brief is enforced here: when retrieval returns too little, the
engine says what it searched and what it could not find, and stops. It never
fills the gap from the model's own knowledge. An optional LLM pass
(LLM_PROVIDER=gemini|groq) may rephrase the retrieved material into prose, but
it is given only those chunks and cannot add a fact.
"""

from __future__ import annotations

import os
import re
import statistics

import db
import search
from extract_evidence import (BATTERY_TYPES, ELECTRODE_ROLES, GRAPHENE_FORMS,
                              PARTNERS, _first_match, normalise)

MIN_EVIDENCE_ROWS = 3
# The text fallback is deliberately hard to satisfy. A loose threshold let
# "what is the melting point of tungsten?" through on the strength of common
# words, which is the exact failure rule 4 exists to prevent.
MIN_CHUNK_COVERAGE = 0.6
MIN_CONTENT_TERMS = 2
MIN_CHUNKS = 2
MAX_CITATIONS = 8
# Share of chunks a term must appear in before the library claims coverage of
# it. A word that turns up in a fraction of a percent is an incidental mention.
COVERAGE_FLOOR = 0.008

# Words common enough in this corpus that matching one says nothing about
# whether the library actually addresses the question.
GENERIC_TERMS = {
    "point", "high", "low", "good", "better", "performance", "material",
    "materials", "study", "result", "results", "value", "values", "work",
    "paper", "show", "shows", "shown", "using", "used", "use", "new", "novel",
    "effect", "effects", "based", "via", "well", "also", "more", "most",
    "than", "between", "during", "after", "before", "when", "where", "while",
    "stop", "stops", "help", "helps", "make", "makes", "give", "gives",
    "many", "much", "long", "does", "reach", "reaches", "get", "gets",
}

# Questions a corpus of measurements cannot answer however well the words
# overlap: advice, commercial recommendation, prediction, personal opinion.
# Term matching alone let "which graphene battery company should I invest in?"
# through, because the corpus is full of "graphene" and "battery" and prefix
# matching reads "invest" inside "investigated".
OUT_OF_REMIT = [
    (r"\bshould\s+(?:i|we|you)\b", "asks for advice"),
    (r"\b(?:invest|investment|investor|stock|shares|share\s+price|ticker|"
     r"market\s+cap|valuation)\b(?!igat)", "asks about investment"),
    (r"\b(?:company|companies|startup|supplier|vendor|manufacturer)\b",
     "asks about companies rather than measurements"),
    (r"\b(?:forecast|predict|projection)\w*\b", "asks for a prediction"),
    (r"\bwill\b[^?]*\b20[2-9]\d\b", "asks for a prediction"),
    (r"\brecommend\w*\b", "asks for a recommendation"),
    (r"\b(?:buy|purchase|cheapest|price)\b", "asks about commerce"),
]


def out_of_remit(question: str):
    """The reason this question is outside what measurements can answer."""
    low = question.lower()
    for pattern, reason in OUT_OF_REMIT:
        if re.search(pattern, low):
            return reason
    return None


QUANTITIES = [
    ("specific_capacity_mah_g", "mAh/g", "specific capacity",
     (r"capacit", r"mah", r"\bcapacity\b")),
    ("capacity_retention_pct", "%", "capacity retention",
     (r"retention", r"retain", r"stabilit", r"fade", r"degrad")),
    ("cycle_count", "cycles", "cycle count",
     (r"cycl", r"\blife\b", r"durab")),
    ("current_density_ma_g", "mA/g", "current density",
     (r"current\s+density", r"\brate\b", r"\ba/g\b", r"ma/g")),
    ("c_rate", "C", "C-rate", (r"c-?rate", r"\brate\s+capab")),
    ("first_cycle_ce_pct", "%", "first-cycle coulombic efficiency",
     (r"coulombic", r"\bice\b", r"efficien")),
    ("areal_loading_mg_cm2", "mg/cm2", "areal loading",
     (r"loading", r"areal")),
]


def detect_facets(question: str) -> dict:
    """Material, form, chemistry and electrode role named in the question."""
    text = normalise(question)
    return {
        "partner": _first_match(PARTNERS, text),
        "graphene_form": _first_match(GRAPHENE_FORMS, text),
        "battery_type": _first_match(BATTERY_TYPES, text),
        "electrode_role": _first_match(ELECTRODE_ROLES, text),
    }


def detect_quantities(question: str) -> list[tuple]:
    """Quantities the question actually asks about. Empty when it asks none.

    No default: answering "do graphene separators stop dendrites?" with a
    median capacity would be a non-answer presented as an answer.
    """
    low = question.lower()
    return [q for q in QUANTITIES if any(re.search(p, low) for p in q[3])]


def stem(term: str) -> str:
    """Crude suffix strip, enough to match a plural query to singular text.

    "separators" must reach text that says "separator", or the library looks
    emptier than it is and the tool refuses a question it can answer.
    """
    low = term.lower()
    for suffix, replacement in (("ies", "y"), ("sses", "ss"), ("es", ""),
                                ("s", "")):
        if low.endswith(suffix) and len(low) - len(suffix) >= 4:
            return low[:-len(suffix)] + replacement
    return low


def content_terms(question: str) -> list[str]:
    """Question terms specific enough to judge whether the library matches."""
    out, seen = [], set()
    for term in search._terms(question):
        if term in GENERIC_TERMS or len(term) <= 2:
            continue
        root = stem(term)
        if root in GENERIC_TERMS or root in seen:
            continue
        seen.add(root)
        out.append(root)
    return out


def covers_in_window(text, needed, window=240):
    """Do enough of these terms appear close together, not merely somewhere?

    Scattered matches are how "how do I build a nuclear reactor" slipped
    through: a graphene paper can mention nuclear magnetic resonance in one
    sentence and a CVD reactor in another. Requiring the terms inside one
    window makes the passage be about the question.
    """
    low = text.lower()
    hits = []
    for term in needed:
        start = 0
        while True:
            at = low.find(term, start)
            if at < 0:
                break
            hits.append((at, term))
            start = at + max(1, len(term))
    if not hits:
        return 0
    hits.sort()
    best, left = 0, 0
    for right in range(len(hits)):
        while hits[right][0] - hits[left][0] > window:
            left += 1
        best = max(best, len({t for _, t in hits[left:right + 1]}))
    return best


def _grounded_chunks(question, chunks, conn):
    """Chunks that genuinely address the question, not merely share a word.

    A chunk must cover most of the question's specific terms and must contain
    the rarest of them, measured against the corpus rather than guessed.
    """
    terms = content_terms(question)
    # One term is enough when it is distinctive and well covered; "C-rate" is a
    # single word and a fundamental one.
    if not terms or (len(terms) < MIN_CONTENT_TERMS
                     and not (len(terms) == 1 and len(terms[0]) >= 4)):
        return []

    frequency = {}
    for term in terms:
        try:
            frequency[term] = conn.execute(
                "SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH ?",
                (f'"{term}"*',)).fetchone()[0]
        except Exception:
            frequency[term] = 0
    if any(f == 0 for f in frequency.values()):
        return []                      # a term the corpus never uses at all
    total = conn.execute("SELECT count(*) FROM chunks").fetchone()[0] or 1
    if min(frequency.values()) < max(8, round(total * COVERAGE_FLOOR)):
        return []                      # present, but not a subject we cover
    rarest = min(frequency, key=frequency.get)

    strong = []
    for chunk in chunks:
        low = chunk["text"].lower()
        hits = [t for t in terms if t in low]
        near = covers_in_window(chunk["text"], terms)
        if (len(hits) >= min(MIN_CONTENT_TERMS, len(terms))
                and len(hits) / len(terms) >= MIN_CHUNK_COVERAGE
                and near / len(terms) >= MIN_CHUNK_COVERAGE
                and rarest in low):
            strong.append(chunk)
    return strong


def _spread(values: list[float]) -> dict:
    values = sorted(values)
    out = {
        "n": len(values),
        "min": round(values[0], 2),
        "max": round(values[-1], 2),
        "median": round(statistics.median(values), 2),
    }
    if len(values) >= 4:
        out["p25"] = round(statistics.quantiles(values, n=4)[0], 2)
        out["p75"] = round(statistics.quantiles(values, n=4)[2], 2)
    return out


def answer(question: str, conn=None) -> dict:
    own = conn is None
    conn = conn or db.connect()
    try:
        facets = detect_facets(question)
        quantities = detect_quantities(question)

        remit = out_of_remit(question)
        if remit:
            return _out_of_remit(question, facets, remit)

        rows = []
        if any(facets.values()):
            material = facets["partner"]
            rows = search.filter_evidence(
                material=material,
                graphene_form=facets["graphene_form"] if not material else None,
                battery_type=facets["battery_type"],
                electrode_role=facets["electrode_role"],
                limit=600, conn=conn)
            if len(rows) < MIN_EVIDENCE_ROWS:
                # Relax the chemistry before giving up on structured evidence.
                rows = search.filter_evidence(
                    material=material,
                    battery_type=facets["battery_type"],
                    limit=600, conn=conn)
        if len(rows) < MIN_EVIDENCE_ROWS:
            rows = search.search_evidence(question, limit=120, conn=conn)

        # Numbers only when the question asks for one.
        if quantities and len(rows) >= MIN_EVIDENCE_ROWS:
            return _quantitative_answer(question, facets, quantities, rows)

        chunks = search.search(question, limit=12, conn=conn)
        strong = _grounded_chunks(question, chunks, conn)
        if len(strong) >= MIN_CHUNKS:
            return _textual_answer(question, strong)

        return _not_found(question, facets, quantities, len(rows), len(chunks))
    finally:
        if own:
            conn.close()


def _label(facets) -> str:
    bits = [facets.get("partner"), facets.get("graphene_form"),
            facets.get("electrode_role"), facets.get("battery_type")]
    bits = [b for b in bits if b]
    return " / ".join(bits) if bits else "the matching papers"


def _quantitative_answer(question, facets, quantities, rows) -> dict:
    stats, missing = {}, []
    for field, unit, label, _ in quantities:
        values = [float(r[field]) for r in rows
                  if r.get(field) is not None and r.get("confidence") != "unverified"]
        if values:
            stats[label] = dict(_spread(values), unit=unit, field=field)
        else:
            missing.append(label)

    primary = next(iter(stats.items()), None)
    subject = _label(facets)
    papers = {r["openalex_id"] for r in rows}
    years = [r["year"] for r in rows if r.get("year")]

    if primary:
        label, s = primary
        sentence = (
            f"Across {s['n']} measurements from {len(papers)} papers, "
            f"{subject} shows a median {label} of {s['median']:g} {s['unit']} "
            f"(range {s['min']:g} to {s['max']:g} {s['unit']}).")
        if "p25" in s:
            sentence += (f" Half the reported values fall between "
                         f"{s['p25']:g} and {s['p75']:g} {s['unit']}.")
    else:
        sentence = (f"{len(rows)} evidence rows match {subject}, but none of them "
                    f"state the quantity asked for.")

    cited = [r for r in rows if r.get("specific_capacity_mah_g") is not None
             or r.get("capacity_retention_pct") is not None][:MAX_CITATIONS]
    flagged = sum(1 for r in rows if r.get("confidence") == "flagged")

    return {
        "question": question,
        "status": "answered",
        "mode": "quantitative",
        "summary": sentence,
        "statistics": stats,
        "citations": [_citation(i, r) for i, r in enumerate(cited, start=1)],
        "coverage": {
            "evidence_rows": len(rows),
            "papers": len(papers),
            "year_range": [min(years), max(years)] if years else None,
            "flagged_rows": flagged,
            "facets_detected": {k: v for k, v in facets.items() if v},
            "not_reported": missing,
        },
    }


def _textual_answer(question, chunks) -> dict:
    papers = {c["openalex_id"] for c in chunks}
    years = [c["year"] for c in chunks if c.get("year")]
    return {
        "question": question,
        "status": "answered",
        "mode": "textual",
        "summary": (f"No comparable numbers were extracted for this question, but "
                    f"{len(chunks)} passages from {len(papers)} papers discuss it. "
                    f"They are quoted below unchanged."),
        "statistics": {},
        "citations": [{
            "n": i,
            "openalex_id": c["openalex_id"],
            "title": c["title"],
            "year": c["year"],
            "journal": c["journal"],
            "doi": c["doi"],
            "quote": c["text"][:600],
            "section": c["section"],
            "confidence": "quoted text, no number extracted",
            "values": {},
        } for i, c in enumerate(chunks[:MAX_CITATIONS], start=1)],
        "coverage": {
            "evidence_rows": 0,
            "papers": len(papers),
            "year_range": [min(years), max(years)] if years else None,
            "flagged_rows": 0,
            "facets_detected": {},
            "not_reported": [],
        },
    }


def _not_found(question, facets, quantities, n_rows, n_chunks) -> dict:
    searched = ["the evidence table", "the indexed abstracts of 6,575 papers"]
    detected = {k: v for k, v in facets.items() if v}
    return {
        "question": question,
        "status": "not_found",
        "mode": "refused",
        "summary": ("Not found in the library. This answer is not available from "
                    "the stored papers, and the tool does not answer from outside "
                    "them."),
        "statistics": {},
        "citations": [],
        "coverage": {
            "evidence_rows": n_rows,
            "papers": 0,
            "year_range": None,
            "flagged_rows": 0,
            "facets_detected": detected,
            "searched": searched,
            "matched_passages": n_chunks,
            "not_reported": [q[2] for q in quantities] or
                            ["no performance quantity was named in the question"],
            "suggestion": ("Try naming a material and a chemistry, for "
                           "example 'silicon graphene anode in lithium-ion', "
                           "or widen the filters on the Evidence table."),
        },
    }


AS_REPORTED = {
    "specific_capacity_mah_g": "capacity_as_reported",
    "current_density_ma_g": "current_density_as_reported",
}


def _out_of_remit(question, facets, reason) -> dict:
    return {
        "question": question,
        "status": "not_found",
        "mode": "refused",
        "summary": ("Not found in the library. This question " + reason + ", and "
                    "the library holds measurements reported in papers, not "
                    "advice, prices or predictions. The tool does not answer "
                    "from outside the stored papers."),
        "statistics": {},
        "citations": [],
        "coverage": {
            "evidence_rows": 0, "papers": 0, "year_range": None,
            "flagged_rows": 0,
            "facets_detected": {k: v for k, v in facets.items() if v},
            "searched": ["nothing: the question is outside what the evidence "
                         "table can answer"],
            "matched_passages": 0,
            "not_reported": [reason],
            "suggestion": ("Ask what the papers measured, for example "
                           "'capacity of silicon graphene anodes in "
                           "lithium-ion' or 'cycle life of rGO cathodes'."),
        },
    }


def _citation(n, row) -> dict:
    values = {}
    for field, unit, label, _ in QUANTITIES:
        if row.get(field) is None:
            continue
        shown = f"{float(row[field]):g} {unit}"
        # Where the stored value is a unit conversion, show the paper's own
        # wording too, so the reader can find the figure in the quote.
        reported = row.get(AS_REPORTED.get(field, ""), None)
        if reported and str(reported).split()[0] not in (row.get("source_quote") or ""):
            pass
        elif reported and f"{float(row[field]):g}" not in (row.get("source_quote") or ""):
            shown = f"{shown} (reported as {reported})"
        values[label] = shown
    return {
        "n": n,
        "evidence_id": row.get("id"),
        "openalex_id": row["openalex_id"],
        "title": row.get("title"),
        "year": row.get("year"),
        "journal": row.get("journal"),
        "doi": row.get("doi"),
        "quote": row.get("source_quote"),
        "section": row.get("source_section"),
        "confidence": row.get("confidence"),
        "material_system": row.get("material_system"),
        "values": values,
    }


def answer_stream(question: str, conn=None):
    """Yield the answer in pieces, so the interface can render as it arrives."""
    result = answer(question, conn=conn)
    yield {"type": "status", "status": result["status"], "mode": result["mode"]}
    for sentence in re.split(r"(?<=\.)\s+", result["summary"]):
        if sentence.strip():
            yield {"type": "summary", "text": sentence.strip() + " "}
    if result["statistics"]:
        yield {"type": "statistics", "statistics": result["statistics"]}
    for citation in result["citations"]:
        yield {"type": "citation", "citation": citation}
    yield {"type": "coverage", "coverage": result["coverage"]}
    yield {"type": "done"}


def llm_enabled() -> bool:
    """An LLM pass is opt-in and may only rephrase retrieved material."""
    return bool(os.environ.get("LLM_PROVIDER")) and bool(
        os.environ.get("GEMINI_API_KEY") or os.environ.get("GROQ_API_KEY"))

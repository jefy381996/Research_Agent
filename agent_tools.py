"""What the agent can actually do.

Each entry is a JSON schema the model reads and a function that runs here.
Results are kept small on purpose: every tool result is re-sent to the model
on the next round, so a generous tool is an expensive one.

Nothing in here trusts the model's arguments. Everything is coerced, bounded
and, where it touches the database, read-only.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import statistics

import calculators
import db
import properties
import extract_evidence as EX
import plausibility
import units

MAX_ROWS = 12
MAX_GROUPS = 20
QUOTE = 240


def _cap(value, default, ceiling):
    """The model may ask for a hundred rows. It does not get a hundred rows:
    every tool result is re-sent on the next round, so an over-generous tool
    is what pushes a conversation past the model's context window."""
    try:
        return max(1, min(int(value), ceiling))
    except (TypeError, ValueError):
        return default


def _spread(values):
    s = sorted(values)
    q = lambda p: s[min(len(s) - 1, max(0, int(round((len(s) - 1) * p))))]
    return {"n": len(s), "min": round(s[0], 2), "max": round(s[-1], 2),
            "median": round(statistics.median(s), 2),
            "p25": round(q(.25), 2), "p75": round(q(.75), 2)}


def _conn():
    return db.connect()


def _digest(row):
    return {
        "id": f"E{row['id']}", "material": row["material_system"],
        "form": row["graphene_form"], "role": row["electrode_role"],
        "chemistry": row["battery_type"],
        "capacity_mah_g": row["specific_capacity_mah_g"],
        "reported_as": row["capacity_as_reported"],
        "current_ma_g": row["current_density_ma_g"], "c_rate": row["c_rate"],
        "cycles": row["cycle_count"], "retention_pct": row["capacity_retention_pct"],
        "first_cycle_ce_pct": row["first_cycle_ce_pct"],
        "confidence": row["confidence"], "year": row["year"],
        "journal": row["journal"], "title": (row["title"] or "")[:110],
        "quote": (row["source_quote"] or "")[:QUOTE],
    }


# ── the tools ──────────────────────────────────────────────────────────────

def describe_library(**_):
    conn = _conn()
    try:
        one = lambda s: conn.execute(s).fetchone()[0]
        tables = {}
        for name in ("papers", "evidence", "concepts", "compounds",
                     "paper_sections", "chunks"):
            cols = [r[1] for r in conn.execute(f"PRAGMA table_info({name})")]
            tables[name] = {"rows": one(f"SELECT count(*) FROM {name}"),
                            "columns": cols}
        facets = {}
        for col in ("material_system", "battery_type", "graphene_form",
                    "electrode_role"):
            facets[col] = [r[0] for r in conn.execute(
                f"SELECT {col} FROM evidence WHERE {col} IS NOT NULL"
                f" GROUP BY 1 ORDER BY count(*) DESC LIMIT 25")]
        return {"tables": tables, "values_present": facets,
                "note": "Use sql_query for anything these tools do not cover. "
                        "Only SELECT is allowed."}
    finally:
        conn.close()


def search_measurements(material=None, graphene_form=None, battery_type=None,
                        electrode_role=None, confidence=None, min_capacity=None,
                        max_capacity=None, min_cycles=None, min_year=None,
                        limit=MAX_ROWS, **_):
    clauses, params = ["e.confidence != 'unverified'"], []
    def like(col, val):
        clauses.append(f"lower({col}) LIKE ?"); params.append(f"%{str(val).lower()}%")
    if material: like("e.material_system", material)
    if graphene_form: like("e.graphene_form", graphene_form)
    if battery_type: like("e.battery_type", battery_type)
    if electrode_role: like("e.electrode_role", electrode_role)
    if confidence in ("verified", "flagged"):
        clauses.append("e.confidence = ?"); params.append(confidence)
    for col, val, op in (("e.specific_capacity_mah_g", min_capacity, ">="),
                         ("e.specific_capacity_mah_g", max_capacity, "<="),
                         ("e.cycle_count", min_cycles, ">="),
                         ("p.year", min_year, ">=")):
        if val is not None:
            try:
                clauses.append(f"{col} {op} ?"); params.append(float(val))
            except (TypeError, ValueError):
                pass
    where = " AND ".join(clauses)
    conn = _conn()
    try:
        rows = conn.execute(
            f"SELECT e.*, p.year, p.journal, p.title, p.doi FROM evidence e"
            f" JOIN papers p ON p.openalex_id=e.openalex_id WHERE {where}"
            f" ORDER BY (e.confidence='verified') DESC,"
            f" e.specific_capacity_mah_g DESC", params).fetchall()
        if not rows:
            return {"matched": 0,
                    "note": "Nothing matches. Loosen a filter, or call "
                            "describe_library to see which values exist."}
        spread = {}
        for field, unit in (("specific_capacity_mah_g", "mAh/g"),
                            ("capacity_retention_pct", "%"),
                            ("cycle_count", "cycles"),
                            ("current_density_ma_g", "mA/g"),
                            ("c_rate", "C"), ("first_cycle_ce_pct", "%")):
            vals = [float(r[field]) for r in rows if r[field] is not None]
            if len(vals) >= 2:
                spread[field] = dict(_spread(vals), unit=unit)
        return {"matched": len(rows),
                "papers": len({r["openalex_id"] for r in rows}),
                "flagged": sum(1 for r in rows if r["confidence"] == "flagged"),
                "spread": spread,
                "rows": [_digest(r) for r in rows[:_cap(limit, MAX_ROWS, MAX_ROWS)]]}
    finally:
        conn.close()


def compare_materials(metric="specific_capacity_mah_g", battery_type=None,
                      electrode_role=None, min_group=3, limit=10, **_):
    allowed = {"specific_capacity_mah_g", "capacity_retention_pct", "cycle_count",
               "first_cycle_ce_pct", "current_density_ma_g", "c_rate"}
    if metric not in allowed:
        return {"error": f"metric must be one of {sorted(allowed)}"}
    clauses, params = [f"e.{metric} IS NOT NULL", "e.confidence != 'unverified'",
                       "e.material_system IS NOT NULL"], []
    if battery_type:
        clauses.append("lower(e.battery_type) LIKE ?"); params.append(f"%{battery_type.lower()}%")
    if electrode_role:
        clauses.append("lower(e.electrode_role) LIKE ?"); params.append(f"%{electrode_role.lower()}%")
    conn = _conn()
    try:
        groups = {}
        for row in conn.execute(
                f"SELECT e.material_system AS m, e.{metric} AS v, e.id FROM evidence e"
                f" WHERE {' AND '.join(clauses)}", params):
            groups.setdefault(row["m"], []).append((float(row["v"]), row["id"]))
        out = []
        for name, pairs in groups.items():
            if len(pairs) < int(min_group or 3):
                continue
            out.append(dict(_spread([v for v, _ in pairs]), material_system=name,
                            example_ids=[f"E{i}" for _, i in pairs[:3]]))
        out.sort(key=lambda g: -g["median"])
        return {"metric": metric, "groups": out[:_cap(limit, 10, MAX_GROUPS)]} if out else {
            "metric": metric, "groups": [],
            "note": "No material system has enough measurements of this metric."}
    finally:
        conn.close()


def trend_by_year(metric="specific_capacity_mah_g", material=None,
                  battery_type=None, min_per_year=2, **_):
    clauses, params = [f"e.{re.sub(r'[^a-z_]', '', metric)} IS NOT NULL",
                       "e.confidence != 'unverified'"], []
    if material:
        clauses.append("lower(e.material_system) LIKE ?"); params.append(f"%{material.lower()}%")
    if battery_type:
        clauses.append("lower(e.battery_type) LIKE ?"); params.append(f"%{battery_type.lower()}%")
    conn = _conn()
    try:
        years = {}
        for row in conn.execute(
                f"SELECT p.year AS y, e.{re.sub(r'[^a-z_]', '', metric)} AS v"
                f" FROM evidence e JOIN papers p ON p.openalex_id=e.openalex_id"
                f" WHERE {' AND '.join(clauses)} AND p.year IS NOT NULL", params):
            years.setdefault(int(row["y"]), []).append(float(row["v"]))
        out = [dict(_spread(v), year=y) for y, v in sorted(years.items())
               if len(v) >= int(min_per_year or 2)]
        return {"metric": metric, "years": out}
    finally:
        conn.close()


def search_literature(query, limit=6, **_):
    terms = [t for t in EX.normalise(str(query)).lower().split() if len(t) > 2]
    if not terms:
        return {"matched": 0, "note": "query too vague"}
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT openalex_id, title, year, journal, doi, abstract FROM papers"
            " WHERE abstract IS NOT NULL AND abstract != ''"
            " ORDER BY citations_per_year DESC LIMIT 9000").fetchall()
        scored = []
        for r in rows:
            low = (r["abstract"] or "").lower()
            hits = sum(1 for t in terms if t in low)
            if hits >= max(1, int(len(terms) * 0.6)):
                scored.append((hits, r))
        scored.sort(key=lambda x: -x[0])
        return {"matched": len(scored),
                "passages": [{"id": f"P{r['openalex_id']}", "title": r["title"],
                              "year": r["year"], "journal": r["journal"],
                              "doi": r["doi"], "text": (r["abstract"] or "")[:700]}
                             for _, r in scored[:_cap(limit, 6, 8)]]}
    finally:
        conn.close()


def knowledge_lookup(term, limit=3, **_):
    conn = _conn()
    try:
        like = f"%{str(term).lower()}%"
        rows = conn.execute(
            "SELECT slug,title,category,summary,description,url,licence,source"
            " FROM concepts WHERE lower(title) LIKE ? OR lower(summary) LIKE ?"
            " ORDER BY length(title) LIMIT ?", (like, like, _cap(limit, 3, 5))).fetchall()
        return {"matched": len(rows), "entries": [dict(r) for r in rows]} if rows else {
            "matched": 0, "note": "No reference entry covers that term."}
    finally:
        conn.close()


def compound_lookup(name, **_):
    conn = _conn()
    try:
        like = f"%{str(name).lower()}%"
        rows = conn.execute(
            "SELECT name,formula,molecular_weight,iupac_name,smiles,url FROM compounds"
            " WHERE lower(name) LIKE ? OR lower(formula) LIKE ? LIMIT 5",
            (like, like)).fetchall()
        return {"matched": len(rows), "compounds": [dict(r) for r in rows]}
    finally:
        conn.close()


def calculate(name, inputs=None, **_):
    fn = calculators.REGISTRY.get(str(name))
    if not fn:
        return {"error": f"unknown calculation {name!r}",
                "available": sorted(calculators.REGISTRY)}
    try:
        clean = {k: float(v) for k, v in (inputs or {}).items()
                 if v not in ("", None)}
        return fn(**clean)
    except TypeError as exc:
        return {"error": f"wrong inputs: {exc}",
                "expected": [i["name"] for i in next(
                    c for c in calculators.catalogue() if c["name"] == name)["inputs"]]}
    except ValueError as exc:
        return {"error": str(exc)}


def convert_units(kind, value, unit, **_):
    fns = {"capacity": units.capacity_to_mah_g, "current": units.current_to_ma_g,
           "loading": units.loading_to_mg_cm2}
    if kind not in fns:
        return {"error": f"kind must be one of {sorted(fns)}"}
    try:
        return fns[kind](float(value), str(unit))
    except (TypeError, ValueError) as exc:
        return {"error": str(exc)}


_SQL_OK = re.compile(r"^\s*(select|with)\b", re.I)
_SQL_BAD = re.compile(
    r"\b(attach|detach|pragma|insert|update|delete|drop|create|alter|replace|"
    r"vacuum|reindex|commit|rollback|begin)\b", re.I)


def sql_query(sql, limit=50, **_):
    """Read-only SELECT over the library. Anything else is refused."""
    text = str(sql or "").strip().rstrip(";")
    if not _SQL_OK.match(text) or _SQL_BAD.search(text) or ";" in text:
        return {"error": "only a single read-only SELECT (or WITH) is allowed"}
    path = os.path.abspath(db.DB_PATH)
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=20)
        conn.row_factory = sqlite3.Row
    except sqlite3.Error as exc:
        return {"error": f"cannot open the library read-only: {exc}"}
    try:
        conn.execute("PRAGMA query_only = ON")
        rows = conn.execute(text).fetchmany(_cap(limit, 50, 100))
        return {"columns": [d[0] for d in (conn.execute(text).description or [])],
                "row_count": len(rows), "rows": [dict(r) for r in rows]}
    except sqlite3.Error as exc:
        return {"error": f"SQL error: {exc}"}
    finally:
        conn.close()


def live_search(query, limit=20, **_):
    import live
    result = live.search(str(query), limit=_cap(limit, 20, 25))
    result.pop("papers", None)
    rows = result.get("rows", [])[:8]
    for row in rows:
        row.pop("_derived", None)
        row["quote"] = (row.pop("source_quote", "") or "")[:QUOTE]
    result["rows"] = rows
    return result


def extract_from_text(text, title="pasted text", **_):
    """Read measurements out of text the researcher supplied."""
    body = str(text or "")
    if len(body) < 40:
        return {"error": "give at least a sentence or two of paper text"}
    rows, rejections = EX.rows_for_paper(
        {"openalex_id": "PASTED", "title": str(title), "abstract": body[:20000]},
        section="pasted text")
    plausibility.assess(rows)
    for row in rows:
        row.pop("_derived", None)
        row["quote"] = (row.pop("source_quote", "") or "")[:QUOTE]
    return {"found": len(rows), "rows": rows[:10],
            "rejected_fields": len(rejections),
            "note": "Read with the same extractor as the library. Not stored."}


def run_analysis(code, **_):
    """Run Python over the measurements. Returns printed output and any plot."""
    import sandbox
    result = sandbox.run(str(code or ""), sandbox.dataset())
    figures = result.pop("figures", [])
    result["figures_produced"] = len(figures)
    result["_figures"] = figures          # stripped before the model sees it
    return result


def _pdigest(row):
    return {
        "id": f"P{row['id']}", "property": row["property_label"],
        "value": row["value"], "unit": row["unit"],
        "reported_as": row["value_as_reported"],
        "material": row["material"], "form": row["graphene_form"],
        "application": row["application"], "confidence": row["confidence"],
        "flags": row["flags"], "year": row["year"], "journal": row["journal"],
        "title": (row["title"] or "")[:110],
        "quote": (row["source_quote"] or "")[:QUOTE],
    }


def list_properties(**_):
    """Which physical properties the library holds numbers for."""
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT property_key, property_label, unit, count(*) n,"
            " sum(confidence='verified') v, min(value) lo, max(value) hi,"
            " count(DISTINCT openalex_id) papers"
            " FROM properties GROUP BY property_key ORDER BY n DESC").fetchall()
        return {"properties": [
            {"key": r["property_key"], "label": r["property_label"],
             "unit": r["unit"], "measurements": r["n"], "verified": r["v"],
             "papers": r["papers"], "range": [r["lo"], r["hi"]]}
            for r in rows],
            "note": "Call search_properties with one of these keys. Ids look "
                    "like P123 and are cited the same way as E ids."}
    finally:
        conn.close()


def search_properties(property_key=None, material=None, application=None,
                      min_value=None, max_value=None, confidence=None,
                      limit=MAX_ROWS, **_):
    """Physical property measurements: thermal, electrical, mechanical, optical."""
    clauses, params = ["1=1"], []

    def like(col, val):
        clauses.append(f"lower({col}) LIKE ?"); params.append(f"%{str(val).lower()}%")

    if property_key:
        key = str(property_key).strip().lower().replace(" ", "_")
        known = set(properties.BY_KEY)
        if key not in known:
            # Accept a label or an alias as well as the key, because a model
            # asked for "thermal conductivity" long before it asked for the key.
            spoken = str(property_key).strip().lower()
            for fam in properties.FAMILIES:
                if spoken == fam["label"].lower() or spoken in fam["aliases"]:
                    key = fam["key"]
                    break
            else:
                return {"error": f"unknown property {property_key!r}",
                        "known": sorted(known)}
        clauses.append("r.property_key = ?"); params.append(key)
    if material: like("r.material", material)
    if application: like("r.application", application)
    if confidence in ("verified", "flagged"):
        clauses.append("r.confidence = ?"); params.append(confidence)
    for val, op in ((min_value, ">="), (max_value, "<=")):
        if val is not None:
            try:
                clauses.append(f"r.value {op} ?"); params.append(float(val))
            except (TypeError, ValueError):
                pass

    conn = _conn()
    try:
        rows = conn.execute(
            f"SELECT r.*, p.year, p.journal, p.title, p.doi FROM properties r"
            f" JOIN papers p ON p.openalex_id=r.openalex_id"
            f" WHERE {' AND '.join(clauses)}"
            f" ORDER BY (r.confidence='verified') DESC, r.value DESC",
            params).fetchall()
        if not rows:
            return {"matched": 0,
                    "note": "Nothing matches. Call list_properties to see which "
                            "properties the library holds."}
        out = {"matched": len(rows),
               "papers": len({r["openalex_id"] for r in rows}),
               "flagged": sum(1 for r in rows if r["confidence"] == "flagged")}
        # One property at a time has a meaningful spread; a mixed set does not.
        keys = {r["property_key"] for r in rows}
        if len(keys) == 1:
            vals = [float(r["value"]) for r in rows]
            out["spread"] = dict(_spread(vals), unit=rows[0]["unit"])
        else:
            out["properties_present"] = sorted(keys)
        out["rows"] = [_pdigest(r) for r in rows[:_cap(limit, MAX_ROWS, MAX_ROWS)]]
        return out
    finally:
        conn.close()


REGISTRY = {
    "describe_library": describe_library,
    "search_measurements": search_measurements,
    "list_properties": list_properties,
    "search_properties": search_properties,
    "compare_materials": compare_materials,
    "trend_by_year": trend_by_year,
    "search_literature": search_literature,
    "knowledge_lookup": knowledge_lookup,
    "compound_lookup": compound_lookup,
    "calculate": calculate,
    "convert_units": convert_units,
    "sql_query": sql_query,
    "live_search": live_search,
    "extract_from_text": extract_from_text,
    "run_analysis": run_analysis,
}


def _p(**props):
    return {"type": "object", "properties": props}


SCHEMAS = [
    ("describe_library", "What the library contains: every table, its columns and "
     "row count, and the values actually present for material system, chemistry, "
     "graphene form and electrode role. Call this before writing SQL or when a "
     "search returns nothing.", _p()),
    ("search_measurements", "Search extracted measurements. Every filter is "
     "optional and matches loosely. Returns how many matched, the spread of each "
     "numeric field, and example rows with ids like E1234 and the sentence each "
     "came from. Cite those ids.",
     _p(material={"type": "string"}, graphene_form={"type": "string"},
        battery_type={"type": "string"}, electrode_role={"type": "string"},
        confidence={"type": "string", "enum": ["verified", "flagged"]},
        min_capacity={"type": "number"}, max_capacity={"type": "number"},
        min_cycles={"type": "number"}, min_year={"type": "number"},
        limit={"type": "number"})),
    ("list_properties", "Which physical properties the library holds numbers "
     "for - thermal conductivity, sheet resistance, Young's modulus, surface "
     "area, transmittance and so on - with the unit, the count and the range of "
     "each. Call this before search_properties when the question is not about "
     "a battery.", _p()),
    ("search_properties", "Search physical property measurements: thermal, "
     "electrical, mechanical, optical, membrane and shielding. Returns the "
     "spread and example rows with ids like P123 and the sentence each came "
     "from. Cite those ids exactly as search_measurements' E ids.",
     _p(property_key={"type": "string",
                      "description": "a key from list_properties, e.g. "
                                     "thermal_conductivity"},
        material={"type": "string"}, application={"type": "string"},
        min_value={"type": "number"}, max_value={"type": "number"},
        confidence={"type": "string", "enum": ["verified", "flagged"]},
        limit={"type": "number"})),
    ("compare_materials", "Median and quartiles of one metric for each material "
     "system, ranked. Use for 'which is better' questions.",
     {"type": "object", "properties": {
        "metric": {"type": "string", "enum": ["specific_capacity_mah_g",
            "capacity_retention_pct", "cycle_count", "first_cycle_ce_pct",
            "current_density_ma_g", "c_rate"]},
        "battery_type": {"type": "string"}, "electrode_role": {"type": "string"},
        "min_group": {"type": "number"}, "limit": {"type": "number"}},
      "required": ["metric"]}),
    ("trend_by_year", "Median of one metric per publication year.",
     {"type": "object", "properties": {
        "metric": {"type": "string"}, "material": {"type": "string"},
        "battery_type": {"type": "string"}}, "required": ["metric"]}),
    ("search_literature", "Keyword search across stored abstracts, for mechanism "
     "and explanation questions. Returns passages with ids like PW123 to cite.",
     {"type": "object", "properties": {"query": {"type": "string"},
      "limit": {"type": "number"}}, "required": ["query"]}),
    ("knowledge_lookup", "Reference entries for a term: what it is, from an open "
     "encyclopaedic source, with a link. Use for definitions.",
     {"type": "object", "properties": {"term": {"type": "string"},
      "limit": {"type": "number"}}, "required": ["term"]}),
    ("compound_lookup", "Chemical identity for a compound: formula, molecular "
     "weight, IUPAC name, from PubChem.",
     {"type": "object", "properties": {"name": {"type": "string"}},
      "required": ["name"]}),
    ("calculate", "Run one of the battery calculators and get its formula, inputs "
     "and result. Use for ALL arithmetic, and for textbook constants: "
     "theoretical_capacity(electrons, molar_mass_g_mol) gives graphite 372 mAh/g "
     "at n=1, M=72.06, silicon 3579 at n=3.75, M=28.085, lithium 3861 at n=1, "
     "M=6.941. Never compute in your head.",
     {"type": "object", "properties": {
        "name": {"type": "string", "enum": sorted(calculators.REGISTRY)},
        "inputs": {"type": "object"}}, "required": ["name", "inputs"]}),
    ("convert_units", "Convert a capacity, current density or areal loading into "
     "the unit the library stores.",
     {"type": "object", "properties": {
        "kind": {"type": "string", "enum": ["capacity", "current", "loading"]},
        "value": {"type": "number"}, "unit": {"type": "string"}},
      "required": ["kind", "value", "unit"]}),
    ("sql_query", "Run a read-only SELECT over the library for anything the other "
     "tools cannot express. Tables: papers, evidence, concepts, compounds. Call "
     "describe_library first for the columns. One statement, SELECT or WITH only.",
     {"type": "object", "properties": {"sql": {"type": "string"},
      "limit": {"type": "number"}}, "required": ["sql"]}),
    ("live_search", "Search OpenAlex right now for work outside the stored "
     "snapshot, and read measurements out of what comes back. Results are leads: "
     "say so when you use them.",
     {"type": "object", "properties": {"query": {"type": "string"},
      "limit": {"type": "number"}}, "required": ["query"]}),
    ("extract_from_text", "Pull measurements out of paper text the researcher "
     "pasted in, using the same extractor as the library.",
     {"type": "object", "properties": {"text": {"type": "string"},
      "title": {"type": "string"}}, "required": ["text"]}),
    ("run_analysis", "Run Python over the measurements for anything bespoke: "
     "custom statistics, correlations, charts. A DataFrame `measurements` is in "
     "scope with the columns describe_library lists, plus `concepts` and "
     "`compounds`. pandas, numpy and matplotlib are available. print() what you "
     "want to see, and call save_plot('name.png') to produce a chart. No network.",
     {"type": "object", "properties": {"code": {"type": "string"}},
      "required": ["code"]}),
]


def tool_specs() -> list[dict]:
    return [{"type": "function", "function": {
        "name": name, "description": desc, "parameters": schema}}
        for name, desc, schema in SCHEMAS]


def run_tool(name: str, arguments: dict) -> dict:
    fn = REGISTRY.get(name)
    if not fn:
        return {"error": f"no such tool {name!r}"}
    try:
        return fn(**(arguments or {}))
    except TypeError as exc:
        return {"error": f"bad arguments for {name}: {exc}"}
    except Exception as exc:                 # a tool failing never ends the turn
        return {"error": f"{type(exc).__name__}: {str(exc)[:200]}"}

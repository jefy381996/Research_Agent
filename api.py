"""FastAPI application: evidence, answering, calculators, upload, export.

One service owns the API and serves the interface, so the whole product
deploys as a single unit with no build step and no second origin to configure.
"""

from __future__ import annotations

import io
import json
import os
import tempfile
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (FileResponse, JSONResponse, StreamingResponse,
                               Response)

import answer as answer_engine
import build_index
import calculators
import db
import plausibility
import search as search_engine
import units

app = FastAPI(
    title="Graphene Battery Evidence Workbench",
    description=("Comparable performance figures extracted from the graphene "
                 "battery literature, each carrying the sentence it came from."),
    version="1.0.0",
)

ALLOWED_ORIGINS = [o for o in os.environ.get(
    "ALLOWED_ORIGINS", "http://localhost:8000,http://127.0.0.1:8000"
).split(",") if o]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

SORTABLE = {
    "specific_capacity_mah_g", "capacity_retention_pct", "cycle_count",
    "current_density_ma_g", "c_rate", "first_cycle_ce_pct", "year",
    "citations_per_year", "material_system", "battery_type", "title",
    "areal_loading_mg_cm2", "temperature_c",
}

EVIDENCE_COLUMNS = [
    "id", "openalex_id", "material_system", "graphene_form", "electrode_role",
    "battery_type", "specific_capacity_mah_g", "capacity_as_reported",
    "initial_capacity_mah_g", "current_density_ma_g",
    "current_density_as_reported", "c_rate", "cycle_count",
    "capacity_retention_pct", "first_cycle_ce_pct", "voltage_window_v",
    "electrolyte", "temperature_c", "areal_loading_mg_cm2", "confidence",
    "flags", "source_quote", "source_section", "title", "year", "journal",
    "doi",
]


def _conn():
    return db.connect()


# --- interface --------------------------------------------------------------

@app.get("/", include_in_schema=False)
def index():
    path = os.path.join(STATIC_DIR, "index.html")
    if not os.path.exists(path):
        return JSONResponse({"detail": "interface not built"}, status_code=404)
    return FileResponse(path)


@app.get("/app.js", include_in_schema=False)
def app_js():
    return FileResponse(os.path.join(STATIC_DIR, "app.js"),
                        media_type="application/javascript")


@app.get("/app.css", include_in_schema=False)
def app_css():
    return FileResponse(os.path.join(STATIC_DIR, "app.css"),
                        media_type="text/css")


# --- evidence ---------------------------------------------------------------

def _evidence_query(material, graphene_form, electrode_role, battery_type,
                    confidence, year_min, year_max, capacity_min, capacity_max,
                    cycles_min, q, sort, direction, limit, offset):
    clauses, params = ["1=1"], []
    if material:
        clauses.append("e.material_system = ?"); params.append(material)
    if graphene_form:
        clauses.append("e.graphene_form = ?"); params.append(graphene_form)
    if electrode_role:
        clauses.append("e.electrode_role = ?"); params.append(electrode_role)
    if battery_type:
        clauses.append("e.battery_type = ?"); params.append(battery_type)
    if confidence:
        clauses.append("e.confidence = ?"); params.append(confidence)
    if year_min is not None:
        clauses.append("p.year >= ?"); params.append(year_min)
    if year_max is not None:
        clauses.append("p.year <= ?"); params.append(year_max)
    if capacity_min is not None:
        clauses.append("e.specific_capacity_mah_g >= ?"); params.append(capacity_min)
    if capacity_max is not None:
        clauses.append("e.specific_capacity_mah_g <= ?"); params.append(capacity_max)
    if cycles_min is not None:
        clauses.append("e.cycle_count >= ?"); params.append(cycles_min)
    if q:
        clauses.append("(lower(p.title) LIKE ? OR lower(e.source_quote) LIKE ?"
                       " OR lower(e.material_system) LIKE ?)")
        like = f"%{q.lower()}%"
        params += [like, like, like]

    if sort not in SORTABLE:
        sort = "specific_capacity_mah_g"
    prefix = "p." if sort in ("year", "citations_per_year", "title") else "e."
    direction = "ASC" if str(direction).lower() == "asc" else "DESC"
    where = " AND ".join(clauses)
    paper_columns = ("title", "year", "journal", "doi")
    select_list = ", ".join(
        ("p." if column in paper_columns else "e.") + column
        for column in EVIDENCE_COLUMNS)
    sql = (f"SELECT {select_list}"
           f" FROM evidence e JOIN papers p ON p.openalex_id = e.openalex_id"
           f" WHERE {where}"
           f" ORDER BY {prefix}{sort} IS NULL, {prefix}{sort} {direction},"
           f" e.id ASC LIMIT ? OFFSET ?")
    count_sql = (f"SELECT count(*) FROM evidence e"
                 f" JOIN papers p ON p.openalex_id = e.openalex_id WHERE {where}")
    return sql, count_sql, params


@app.get("/api/evidence", summary="Query the evidence table")
def get_evidence(
    material: str | None = None,
    graphene_form: str | None = None,
    electrode_role: str | None = None,
    battery_type: str | None = None,
    confidence: str | None = None,
    year_min: int | None = None,
    year_max: int | None = None,
    capacity_min: float | None = None,
    capacity_max: float | None = None,
    cycles_min: int | None = None,
    q: str | None = None,
    sort: str = "specific_capacity_mah_g",
    direction: str = "desc",
    limit: int = Query(100, ge=1, le=2000),
    offset: int = Query(0, ge=0),
):
    conn = _conn()
    try:
        sql, count_sql, params = _evidence_query(
            material, graphene_form, electrode_role, battery_type, confidence,
            year_min, year_max, capacity_min, capacity_max, cycles_min, q,
            sort, direction, limit, offset)
        total = conn.execute(count_sql, params).fetchone()[0]
        rows = conn.execute(sql, params + [limit, offset]).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            try:
                item["flags"] = json.loads(item.get("flags") or "[]")
            except (TypeError, ValueError):
                item["flags"] = []
            out.append(item)
        return {"total": total, "limit": limit, "offset": offset, "rows": out}
    finally:
        conn.close()


@app.get("/api/facets", summary="Filter rail values with counts")
def get_facets():
    conn = _conn()
    try:
        def facet(column):
            return [{"value": r[0], "count": r[1]} for r in conn.execute(
                f"SELECT {column}, count(*) FROM evidence"
                f" WHERE {column} IS NOT NULL AND {column} != ''"
                f" GROUP BY 1 ORDER BY 2 DESC LIMIT 40")]
        years = conn.execute(
            "SELECT p.year, count(*) FROM evidence e"
            " JOIN papers p ON p.openalex_id=e.openalex_id"
            " WHERE p.year IS NOT NULL GROUP BY 1 ORDER BY 1").fetchall()
        return {
            "material_system": facet("material_system"),
            "graphene_form": facet("graphene_form"),
            "electrode_role": facet("electrode_role"),
            "battery_type": facet("battery_type"),
            "confidence": facet("confidence"),
            "year": [{"value": r[0], "count": r[1]} for r in years],
        }
    finally:
        conn.close()


@app.get("/api/stats", summary="Corpus and evidence counts")
def get_stats():
    conn = _conn()
    try:
        one = lambda s: conn.execute(s).fetchone()[0]
        return {
            "papers": one("SELECT count(*) FROM papers"),
            "papers_with_text": one("SELECT count(*) FROM paper_sections"),
            "papers_reusable": one(
                "SELECT count(*) FROM papers WHERE full_text_reusable='yes'"),
            "evidence_rows": one("SELECT count(*) FROM evidence"),
            "verified": one("SELECT count(*) FROM evidence WHERE confidence='verified'"),
            "flagged": one("SELECT count(*) FROM evidence WHERE confidence='flagged'"),
            "unverified": one(
                "SELECT count(*) FROM evidence WHERE confidence='unverified'"),
            "material_systems": one(
                "SELECT count(DISTINCT material_system) FROM evidence"),
            "year_range": list(conn.execute(
                "SELECT min(year), max(year) FROM papers WHERE year IS NOT NULL"
            ).fetchone()),
            "chunks": one("SELECT count(*) FROM chunks"),
            "user_documents": one("SELECT count(*) FROM user_documents"),
            "checks": {
                "capacity_hard_max_mah_g": plausibility.CAPACITY_HARD_MAX,
                "cycle_hard_max": plausibility.CYCLE_HARD_MAX,
                "temperature_range_c": [plausibility.TEMP_MIN, plausibility.TEMP_MAX],
                "voltage_range_v": [plausibility.VOLTAGE_MIN, plausibility.VOLTAGE_MAX],
                "outlier_sigma": plausibility.OUTLIER_SIGMA,
            },
            "theoretical_reference_mah_g": plausibility.THEORETICAL,
        }
    finally:
        conn.close()


@app.get("/api/paper/{openalex_id}", summary="One paper with its evidence")
def get_paper(openalex_id: str):
    conn = _conn()
    try:
        paper = conn.execute("SELECT * FROM papers WHERE openalex_id=?",
                             (openalex_id,)).fetchone()
        if not paper:
            raise HTTPException(status_code=404, detail="paper not found")
        item = dict(paper)
        try:
            item["authors"] = json.loads(item.get("authors") or "[]")
        except (TypeError, ValueError):
            item["authors"] = []
        rows = conn.execute(
            "SELECT * FROM evidence WHERE openalex_id=? ORDER BY id",
            (openalex_id,)).fetchall()
        item["evidence"] = []
        for row in rows:
            ev = dict(row)
            try:
                ev["flags"] = json.loads(ev.get("flags") or "[]")
            except (TypeError, ValueError):
                ev["flags"] = []
            item["evidence"].append(ev)
        return item
    finally:
        conn.close()


@app.get("/api/sources", summary="Every paper with licence and text status")
def get_sources(limit: int = Query(500, ge=1, le=7000), offset: int = 0,
                q: str | None = None):
    conn = _conn()
    try:
        clauses, params = ["1=1"], []
        if q:
            clauses.append("(lower(p.title) LIKE ? OR lower(p.journal) LIKE ?)")
            params += [f"%{q.lower()}%"] * 2
        where = " AND ".join(clauses)
        total = conn.execute(
            f"SELECT count(*) FROM papers p WHERE {where}", params).fetchone()[0]
        rows = conn.execute(f"""
            SELECT p.openalex_id, p.title, p.year, p.journal, p.doi, p.licence,
                   p.oa_status, p.full_text_reusable, p.fetched_at,
                   p.citations_per_year, p.source,
                   (SELECT count(*) FROM paper_sections s
                     WHERE s.openalex_id=p.openalex_id) AS stored_sections,
                   (SELECT count(*) FROM evidence e
                     WHERE e.openalex_id=p.openalex_id) AS evidence_rows
            FROM papers p WHERE {where}
            ORDER BY p.citations_per_year DESC LIMIT ? OFFSET ?
        """, params + [limit, offset]).fetchall()
        return {"total": total, "rows": [dict(r) for r in rows]}
    finally:
        conn.close()


# --- ask --------------------------------------------------------------------

@app.post("/api/ask", summary="Ask a question, answered only from the library")
def ask(payload: dict):
    question = (payload or {}).get("question", "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")

    def stream():
        conn = _conn()
        try:
            for event in answer_engine.answer_stream(question, conn=conn):
                yield json.dumps(event) + "\n"
        except Exception as exc:
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"
        finally:
            conn.close()

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.get("/api/search", summary="Retrieval only, no answering")
def get_search(q: str, limit: int = Query(10, ge=1, le=50)):
    return {"query": q, "results": search_engine.search(q, limit=limit)}


# --- calculators and units --------------------------------------------------

@app.get("/api/calculators", summary="Available calculators and their inputs")
def get_calculators():
    import inspect
    out = []
    for name, fn in calculators.REGISTRY.items():
        signature = inspect.signature(fn)
        out.append({
            "name": name,
            "description": (fn.__doc__ or "").strip().split("\n")[0],
            "inputs": [{"name": p.name,
                        "required": p.default is inspect.Parameter.empty,
                        "default": None if p.default is inspect.Parameter.empty
                                   else p.default}
                       for p in signature.parameters.values()],
        })
    return {"calculators": out,
            "capacity_units": units.ALL_CAPACITY_UNITS,
            "current_units": units.ALL_CURRENT_UNITS}


@app.post("/api/calculate", summary="Run a calculator")
def post_calculate(payload: dict):
    name = (payload or {}).get("name")
    inputs = (payload or {}).get("inputs") or {}
    fn = calculators.REGISTRY.get(name)
    if not fn:
        raise HTTPException(status_code=404,
                            detail=f"unknown calculator: {name}")
    try:
        clean = {k: float(v) for k, v in inputs.items() if v not in ("", None)}
        result = fn(**clean)
    except TypeError as exc:
        raise HTTPException(status_code=400, detail=f"bad inputs: {exc}")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    reference = None
    if name == "energy_density":
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT material_id, formula, working_ion, average_voltage,"
                " gravimetric_capacity, energy_density FROM mp_reference"
                " ORDER BY abs(coalesce(energy_density,0) - ?) LIMIT 3",
                (result["result"],)).fetchall()
            reference = [dict(r) for r in rows] or None
        finally:
            conn.close()
    return {"calculator": name, **result, "reference": reference}


@app.post("/api/convert", summary="Convert between units")
def post_convert(payload: dict):
    kind = (payload or {}).get("kind")
    value = (payload or {}).get("value")
    unit = (payload or {}).get("unit")
    handlers = {
        "capacity": units.capacity_to_mah_g,
        "current": units.current_to_ma_g,
        "loading": units.loading_to_mg_cm2,
    }
    if kind not in handlers:
        raise HTTPException(status_code=400,
                            detail=f"kind must be one of {sorted(handlers)}")
    try:
        return handlers[kind](float(value), unit)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# --- my library -------------------------------------------------------------

@app.post("/api/upload", summary="Upload a PDF, extract its text, index it")
def post_upload(file: UploadFile = File(...)):
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="only PDF files are accepted")
    import pymupdf

    raw = file.file.read()
    if len(raw) > 60 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="file larger than 60 MB")

    # The PDF is written to a temporary file, read, and deleted. No PDF is kept.
    tmp_dir = tempfile.mkdtemp(prefix="upload-")
    tmp_path = os.path.join(tmp_dir, "document.pdf")
    try:
        with open(tmp_path, "wb") as fh:
            fh.write(raw)
        try:
            document = pymupdf.open(tmp_path)
        except Exception as exc:
            raise HTTPException(status_code=400,
                                detail=f"could not read the PDF: {exc}")
        pages = document.page_count
        text = "\n".join(page.get_text() for page in document)
        document.close()
    finally:
        for path in (tmp_path,):
            if os.path.exists(path):
                os.unlink(path)
        if os.path.isdir(tmp_dir):
            os.rmdir(tmp_dir)

    if not text.strip():
        raise HTTPException(
            status_code=422,
            detail="no text layer found; this looks like a scanned PDF")

    import extract_evidence

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn = _conn()
    try:
        cursor = conn.execute(
            "INSERT INTO user_documents(filename, uploaded_at, page_count,"
            " char_count) VALUES(?,?,?,?)",
            (file.filename, now, pages, len(text)))
        doc_id = cursor.lastrowid
        synthetic_id = f"USER{doc_id}"
        conn.execute(
            "INSERT INTO papers(openalex_id, title, year, journal, abstract,"
            " source, full_text_reusable, fetched_at, authors)"
            " VALUES(?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(openalex_id) DO UPDATE SET abstract=excluded.abstract",
            (synthetic_id, file.filename, None, "Uploaded by you", text,
             "upload", "yes", now, "[]"))
        conn.execute(
            "INSERT INTO paper_sections(openalex_id, section, content)"
            " VALUES(?,?,?) ON CONFLICT(openalex_id, section)"
            " DO UPDATE SET content=excluded.content",
            (synthetic_id, "full_text", text))
        for ordinal, piece in enumerate(build_index.chunk(text)):
            conn.execute(
                "INSERT INTO chunks(openalex_id, section, ordinal, text)"
                " VALUES(?,?,?,?) ON CONFLICT(openalex_id, section, ordinal)"
                " DO UPDATE SET text=excluded.text",
                (synthetic_id, "full_text", ordinal, piece))
        conn.commit()

        paper = conn.execute(
            "SELECT openalex_id, title, abstract FROM papers WHERE openalex_id=?",
            (synthetic_id,)).fetchone()
        rows, _ = extract_evidence.rows_for_paper(paper, section="full_text")
        plausibility.assess(rows)
        fields = extract_evidence.INSERT_FIELDS
        assignments = ",".join(f"{f}=excluded.{f}" for f in fields
                               if f != "row_hash")
        sql = (f"INSERT INTO evidence({','.join(fields)})"
               f" VALUES({','.join('?' * len(fields))})"
               f" ON CONFLICT(row_hash) DO UPDATE SET {assignments}")
        written = 0
        for row in rows:
            row.pop("_derived", None)
            row["row_hash"] = extract_evidence.row_hash(row)
            row["flags"] = json.dumps(row.get("flags") or [])
            row["extracted_at"] = now
            try:
                conn.execute(sql, [row.get(f) for f in fields])
                written += 1
            except Exception:
                pass
        conn.commit()
        conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")
        conn.commit()
        return {
            "document_id": doc_id,
            "openalex_id": synthetic_id,
            "filename": file.filename,
            "page_count": pages,
            "characters": len(text),
            "evidence_rows": written,
            "pdf_retained": False,
        }
    finally:
        conn.close()


@app.get("/api/documents", summary="Documents you uploaded")
def get_documents():
    conn = _conn()
    try:
        return {"rows": [dict(r) for r in conn.execute(
            "SELECT * FROM user_documents ORDER BY id DESC")]}
    finally:
        conn.close()


# --- export -----------------------------------------------------------------

EXPORT_COLUMNS = [
    "material_system", "graphene_form", "electrode_role", "battery_type",
    "specific_capacity_mah_g", "capacity_as_reported", "current_density_ma_g",
    "c_rate", "cycle_count", "capacity_retention_pct", "first_cycle_ce_pct",
    "voltage_window_v", "electrolyte", "temperature_c",
    "areal_loading_mg_cm2", "confidence", "flags", "title", "year", "journal",
    "doi", "source_section", "source_quote",
]


def _export_rows(params):
    conn = _conn()
    try:
        sql, _, values = _evidence_query(
            params.get("material"), params.get("graphene_form"),
            params.get("electrode_role"), params.get("battery_type"),
            params.get("confidence"), params.get("year_min"),
            params.get("year_max"), params.get("capacity_min"),
            params.get("capacity_max"), params.get("cycles_min"),
            params.get("q"), params.get("sort", "specific_capacity_mah_g"),
            params.get("direction", "desc"), 50000, 0)
        return [dict(r) for r in conn.execute(sql, values + [50000, 0])]
    finally:
        conn.close()


@app.get("/api/export.csv", summary="Export the current view as CSV")
def export_csv(material: str | None = None, graphene_form: str | None = None,
               electrode_role: str | None = None, battery_type: str | None = None,
               confidence: str | None = None, year_min: int | None = None,
               year_max: int | None = None, capacity_min: float | None = None,
               capacity_max: float | None = None, cycles_min: int | None = None,
               q: str | None = None, sort: str = "specific_capacity_mah_g",
               direction: str = "desc"):
    import csv
    rows = _export_rows(locals())
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=EXPORT_COLUMNS,
                            extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        row["flags"] = "; ".join(json.loads(row.get("flags") or "[]"))
        writer.writerow({c: row.get(c, "") for c in EXPORT_COLUMNS})
    return Response(
        buffer.getvalue(), media_type="text/csv",
        headers={"Content-Disposition":
                 'attachment; filename="graphene-battery-evidence.csv"'})


@app.get("/api/export.xlsx", summary="Export the current view as XLSX")
def export_xlsx(material: str | None = None, graphene_form: str | None = None,
                electrode_role: str | None = None, battery_type: str | None = None,
                confidence: str | None = None, year_min: int | None = None,
                year_max: int | None = None, capacity_min: float | None = None,
                capacity_max: float | None = None, cycles_min: int | None = None,
                q: str | None = None, sort: str = "specific_capacity_mah_g",
                direction: str = "desc"):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font
    from openpyxl.utils import get_column_letter

    rows = _export_rows(locals())
    book = Workbook()
    sheet = book.active
    sheet.title = "Evidence"
    sheet.append(EXPORT_COLUMNS)
    for cell in sheet[1]:
        cell.font = Font(bold=True)
    for row in rows:
        flags = "; ".join(json.loads(row.get("flags") or "[]"))
        sheet.append([flags if c == "flags" else row.get(c)
                      for c in EXPORT_COLUMNS])
    widths = {"source_quote": 90, "title": 60, "flags": 40,
              "material_system": 20, "doi": 28, "journal": 32}
    for index, column in enumerate(EXPORT_COLUMNS, start=1):
        sheet.column_dimensions[get_column_letter(index)].width = \
            widths.get(column, 16)
    for row in sheet.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(vertical="top", wrap_text=False)
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions

    notes = book.create_sheet("How to read this")
    for line in [
        ["Graphene Battery Evidence Workbench export"],
        ["Generated", datetime.now(timezone.utc).isoformat(timespec="seconds")],
        [],
        ["Every number in a row was read from the sentence in source_quote."],
        ["An empty cell means the paper did not state that value. Nothing is"],
        ["estimated, averaged or converted from a value a paper did not give,"],
        ["except where a unit conversion is noted in the as-reported column."],
        [],
        ["confidence=verified", "passed every automated check"],
        ["confidence=flagged", "failed a check; the reason is in flags"],
        [],
        ["The checks test physical plausibility, internal arithmetic, group"],
        ["outliers and unit sanity. They cannot tell whether a plausible"],
        ["number was measured under the conditions the row claims, cannot"],
        ["catch a paper that is itself wrong, and cannot judge whether a"],
        ["comparison is scientifically fair."],
    ]:
        notes.append(line)
    notes.column_dimensions["A"].width = 74
    notes.column_dimensions["B"].width = 44

    stream = io.BytesIO()
    book.save(stream)
    stream.seek(0)
    return Response(
        stream.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument."
                   "spreadsheetml.sheet",
        headers={"Content-Disposition":
                 'attachment; filename="graphene-battery-evidence.xlsx"'})


@app.get("/api/health", summary="Liveness and corpus readiness")
def health():
    conn = _conn()
    try:
        evidence = conn.execute("SELECT count(*) FROM evidence").fetchone()[0]
        return {"status": "ok" if evidence else "empty", "evidence_rows": evidence}
    finally:
        conn.close()

"""SQLite schema and connection helpers.

SQLite rather than Postgres: the corpus is a few thousand papers, FTS5 gives
full-text search with no extension to install, the database is a single file
that ships with the repo, and the whole application deploys as one unit. The
schema mirrors the brief's table design so a move to Postgres is a port of
this file alone.
"""

from __future__ import annotations

import json
import os
import sqlite3

DB_PATH = os.environ.get("DB_PATH", "data/research_agent.db")

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS papers (
    openalex_id        TEXT PRIMARY KEY,
    doi                TEXT UNIQUE,
    title              TEXT NOT NULL,
    year               INTEGER,
    publication_date   TEXT,
    journal            TEXT,
    publisher          TEXT,
    authors            TEXT,
    cited_by_count     INTEGER DEFAULT 0,
    citations_per_year REAL DEFAULT 0,
    abstract           TEXT,
    oa_status          TEXT,
    licence            TEXT,
    full_text_reusable TEXT,
    pdf_url            TEXT,
    landing_url        TEXT,
    source             TEXT DEFAULT 'openalex',
    source_queries     TEXT,
    is_preprint        TEXT DEFAULT 'no',
    fetched_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(year);
CREATE INDEX IF NOT EXISTS idx_papers_cpy  ON papers(citations_per_year DESC);
CREATE INDEX IF NOT EXISTS idx_papers_reuse ON papers(full_text_reusable);

CREATE TABLE IF NOT EXISTS paper_sections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    openalex_id TEXT NOT NULL REFERENCES papers(openalex_id) ON DELETE CASCADE,
    section     TEXT NOT NULL,
    content     TEXT NOT NULL,
    UNIQUE(openalex_id, section)
);

CREATE TABLE IF NOT EXISTS chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    openalex_id TEXT NOT NULL REFERENCES papers(openalex_id) ON DELETE CASCADE,
    section     TEXT,
    ordinal     INTEGER,
    text        TEXT NOT NULL,
    UNIQUE(openalex_id, section, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_chunks_paper ON chunks(openalex_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text,
    content='chunks',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS evidence (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    openalex_id               TEXT NOT NULL REFERENCES papers(openalex_id) ON DELETE CASCADE,
    material_system           TEXT,
    graphene_form             TEXT,
    electrode_role            TEXT,
    battery_type              TEXT,
    specific_capacity_mah_g   REAL,
    capacity_as_reported      TEXT,
    initial_capacity_mah_g    REAL,
    current_density_ma_g      REAL,
    current_density_as_reported TEXT,
    c_rate                    REAL,
    cycle_count               INTEGER,
    capacity_retention_pct    REAL,
    first_cycle_ce_pct        REAL,
    voltage_window_v          TEXT,
    electrolyte               TEXT,
    temperature_c             REAL,
    areal_loading_mg_cm2      REAL,
    source_quote              TEXT NOT NULL,
    source_section            TEXT,
    confidence                TEXT,
    flags                     TEXT,
    extracted_at              TEXT,
    -- Identity is a content hash, not a tuple of columns: SQLite treats every
    -- NULL as distinct, so a UNIQUE tuple containing a NULL never conflicts
    -- and a re-run would insert the same finding again.
    row_hash                  TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_ev_paper ON evidence(openalex_id);
CREATE INDEX IF NOT EXISTS idx_ev_conf  ON evidence(confidence);
CREATE INDEX IF NOT EXISTS idx_ev_mat   ON evidence(material_system);
CREATE INDEX IF NOT EXISTS idx_ev_type  ON evidence(battery_type);
CREATE INDEX IF NOT EXISTS idx_ev_cap   ON evidence(specific_capacity_mah_g DESC);

CREATE TABLE IF NOT EXISTS mp_reference (
    material_id        TEXT PRIMARY KEY,
    formula            TEXT,
    working_ion        TEXT,
    average_voltage    REAL,
    gravimetric_capacity REAL,
    volumetric_capacity  REAL,
    energy_density     REAL,
    max_volume_change  REAL,
    source             TEXT
);

CREATE TABLE IF NOT EXISTS user_documents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT NOT NULL,
    uploaded_at TEXT,
    page_count  INTEGER,
    char_count  INTEGER
);

CREATE TABLE IF NOT EXISTS run_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_type       TEXT NOT NULL,
    started_at     TEXT,
    finished_at    TEXT,
    records_added  INTEGER DEFAULT 0,
    records_updated INTEGER DEFAULT 0,
    errors_json    TEXT
);
"""

# Keep the FTS index in step with the chunks table.
TRIGGERS = """
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
"""


def connect(path: str | None = None) -> sqlite3.Connection:
    path = path or DB_PATH
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init(path: str | None = None) -> sqlite3.Connection:
    """Create everything, idempotently, migrating an older database."""
    conn = connect(path)
    _migrate(conn)
    conn.executescript(SCHEMA)
    conn.executescript(TRIGGERS)
    conn.commit()
    return conn


def _migrate(conn):
    """Rebuild `evidence` if it predates the row_hash identity column.

    Evidence is fully reproducible from `papers` in a few seconds, so dropping
    and re-extracting is cheaper and safer than a column backfill.
    """
    present = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='evidence'"
    ).fetchone()
    if not present:
        return
    columns = {r[1] for r in conn.execute("PRAGMA table_info(evidence)")}
    if "row_hash" not in columns:
        conn.execute("DROP TABLE evidence")
        conn.commit()
        print("migration: evidence table rebuilt for row_hash identity")


def log_run(conn, run_type, started_at, finished_at, added=0, updated=0, errors=None):
    conn.execute(
        "INSERT INTO run_log(run_type, started_at, finished_at, records_added,"
        " records_updated, errors_json) VALUES (?,?,?,?,?,?)",
        (run_type, started_at, finished_at, added, updated,
         json.dumps(errors or [])),
    )
    conn.commit()

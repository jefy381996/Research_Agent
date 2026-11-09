"""Remember what the agent answered, so the same question answers the same way.

A model is not deterministic. Asked twice, it will word things differently and
may take a different route to the same place. For a tool whose whole claim is
traceability, that is a problem on demo day and a real one in a lab: two
researchers asking the same question should see the same answer.

So every completed run is stored whole - the working, the tool calls, the
answer, the verification - and a repeat replays it exactly. That also means a
repeat costs nothing, which matters when the provider's free tier is thin.

The key is the question, the provider and the model: change the model and you
get a fresh answer, because it is a different instrument.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone

import db

MAX_ENTRIES = 2000


def normalise(question: str) -> str:
    """Two questions that differ only in spacing or punctuation are one."""
    text = (question or "").strip().lower()
    text = re.sub(r"\s+", " ", text)
    return re.sub(r"[?!.,;:'\"]+$", "", text).strip()


def key(question: str, provider: str, model: str) -> str:
    raw = f"{normalise(question)}\x00{provider}\x00{model}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def get(question: str, provider: str, model: str) -> list[dict] | None:
    """The stored run for this question, or None."""
    try:
        conn = db.connect()
    except Exception:
        return None
    try:
        row = conn.execute(
            "SELECT events_json FROM agent_cache WHERE qhash=?",
            (key(question, provider, model),)).fetchone()
        if not row:
            return None
        conn.execute(
            "UPDATE agent_cache SET hits=hits+1, last_hit=? WHERE qhash=?",
            (datetime.now(timezone.utc).isoformat(timespec="seconds"),
             key(question, provider, model)))
        conn.commit()
        return json.loads(row[0])
    except Exception:
        return None
    finally:
        conn.close()


def put(question: str, provider: str, model: str, events: list[dict]) -> None:
    """Store a finished run. A run that errored is never stored: a transient
    rate limit must not become the permanent answer to a question."""
    if not any(e.get("type") == "answer" for e in events):
        return
    if any(e.get("type") == "error" for e in events):
        return
    try:
        conn = db.connect()
    except Exception:
        return
    try:
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        conn.execute(
            "INSERT INTO agent_cache(qhash, question, provider, model,"
            " events_json, created_at, hits, last_hit) VALUES(?,?,?,?,?,?,0,NULL)"
            " ON CONFLICT(qhash) DO UPDATE SET events_json=excluded.events_json,"
            " created_at=excluded.created_at",
            (key(question, provider, model), question.strip(), provider, model,
             json.dumps(events, default=str), now))
        conn.execute(
            "DELETE FROM agent_cache WHERE qhash NOT IN ("
            " SELECT qhash FROM agent_cache ORDER BY hits DESC, created_at DESC"
            " LIMIT ?)", (MAX_ENTRIES,))
        conn.commit()
    except Exception:
        pass
    finally:
        conn.close()


def saved(limit: int = 12) -> list[dict]:
    """The questions that already have a stored run.

    These replay with no key and no quota, so they are the ones a demo can
    rely on. Most-replayed first, then newest.
    """
    try:
        conn = db.connect()
    except Exception:
        return []
    try:
        rows = conn.execute(
            "SELECT question, provider, model, hits, created_at FROM agent_cache"
            " ORDER BY hits DESC, created_at DESC LIMIT ?", (int(limit),)).fetchall()
        return [{"question": r[0], "provider": r[1], "model": r[2],
                 "replays": r[3], "stored_at": r[4]} for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def stats() -> dict:
    try:
        conn = db.connect()
    except Exception:
        return {"entries": 0, "hits": 0}
    try:
        row = conn.execute(
            "SELECT count(*), coalesce(sum(hits),0) FROM agent_cache").fetchone()
        return {"entries": row[0], "replays": row[1]}
    finally:
        conn.close()


def clear() -> int:
    conn = db.connect()
    try:
        n = conn.execute("SELECT count(*) FROM agent_cache").fetchone()[0]
        conn.execute("DELETE FROM agent_cache")
        conn.commit()
        return n
    finally:
        conn.close()

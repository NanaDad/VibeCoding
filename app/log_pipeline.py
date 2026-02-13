from __future__ import annotations

import csv
import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS ingest_files (
  file_hash TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  ingested_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  event_ts TEXT NOT NULL,
  ch TEXT,
  type TEXT,
  id1 TEXT,
  glass TEXT,
  id2 TEXT,
  id3 TEXT,
  descript_raw TEXT,
  desc_tokens_json TEXT,
  event_kind TEXT,
  action TEXT,
  from_unit TEXT,
  to_unit TEXT,
  phase TEXT,
  metric_name TEXT,
  metric_value REAL,
  UNIQUE(file_hash, line_no)
);

CREATE TABLE IF NOT EXISTS open_intervals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pairing_key TEXT NOT NULL,
  start_event_id INTEGER NOT NULL,
  start_ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interval_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pairing_key TEXT NOT NULL,
  action TEXT,
  ch TEXT,
  start_event_id INTEGER NOT NULL,
  end_event_id INTEGER NOT NULL,
  start_ts TEXT NOT NULL,
  end_ts TEXT NOT NULL,
  duration_ms INTEGER NOT NULL
);
"""


@dataclass
class ParsedDescript:
    event_kind: str
    action: Optional[str] = None
    from_unit: Optional[str] = None
    to_unit: Optional[str] = None
    phase: Optional[str] = None
    metric_name: Optional[str] = None
    metric_value: Optional[float] = None
    tokens: tuple[str, ...] = ()


def parse_descript(text: str) -> ParsedDescript:
    tokens = tuple(part.strip() for part in (text or "").split("=") if part.strip() != "")
    if not tokens:
        return ParsedDescript(event_kind="unknown", tokens=())

    tail = tokens[-1].upper()
    if tail in {"START", "END"}:
        action = tokens[0] if len(tokens) >= 1 else None
        from_unit = tokens[1] if len(tokens) >= 2 else None
        to_unit = tokens[2] if len(tokens) >= 3 else None
        return ParsedDescript(
            event_kind="interval_start" if tail == "START" else "interval_end",
            action=action,
            from_unit=from_unit,
            to_unit=to_unit,
            phase=tail,
            tokens=tokens,
        )

    if len(tokens) >= 2:
        try:
            value = float(tokens[-1])
            return ParsedDescript(
                event_kind="point_metric",
                metric_name="=".join(tokens[:-1]),
                metric_value=value,
                tokens=tokens,
            )
        except ValueError:
            pass

    return ParsedDescript(event_kind="state_snapshot", metric_name="=".join(tokens), tokens=tokens)


def parse_event_time(time_token: str) -> str:
    # input example: 0209_1624_26.064 (MMDD_HHMM_SS.mmm)
    now = datetime.now()
    try:
        month = int(time_token[0:2])
        day = int(time_token[2:4])
        hour = int(time_token[5:7])
        minute = int(time_token[7:9])
        second = int(time_token[10:12])
        ms = int(time_token[13:16])
        dt = datetime(now.year, month, day, hour, minute, second, ms * 1000)
        return dt.isoformat(timespec="milliseconds")
    except Exception:
        return time_token


def compute_pairing_key(row: dict, parsed: ParsedDescript) -> str:
    key = {
        "action": parsed.action,
        "ch": row.get("CH"),
        "id1": row.get("ID1"),
        "glass": row.get("Glass"),
        "id2": row.get("ID2"),
        "id3": row.get("ID3"),
        "from": parsed.from_unit,
        "to": parsed.to_unit,
    }
    return json.dumps(key, sort_keys=True, ensure_ascii=False)


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_SQL)
    conn.commit()


def is_already_ingested(conn: sqlite3.Connection, file_hash: str) -> bool:
    cur = conn.execute("SELECT 1 FROM ingest_files WHERE file_hash = ?", (file_hash,))
    return cur.fetchone() is not None


def ingest_csv(csv_path: Path, db_path: Path) -> dict:
    conn = sqlite3.connect(db_path)
    ensure_schema(conn)

    fhash = file_sha256(csv_path)
    if is_already_ingested(conn, fhash):
        conn.close()
        return {"status": "skipped", "reason": "duplicate_file_hash", "file_hash": fhash}

    inserted_raw = 0
    inserted_blocks = 0

    with csv_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for line_no, row in enumerate(reader, start=2):
            parsed = parse_descript(row.get("Descript", ""))
            event_ts = parse_event_time(row.get("Time", ""))

            cur = conn.execute(
                """
                INSERT OR IGNORE INTO raw_events (
                  file_hash, line_no, event_ts, ch, type, id1, glass, id2, id3,
                  descript_raw, desc_tokens_json, event_kind, action, from_unit,
                  to_unit, phase, metric_name, metric_value
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    fhash,
                    line_no,
                    event_ts,
                    row.get("CH"),
                    row.get("Type"),
                    row.get("ID1"),
                    row.get("Glass"),
                    row.get("ID2"),
                    row.get("ID3"),
                    row.get("Descript"),
                    json.dumps(parsed.tokens, ensure_ascii=False),
                    parsed.event_kind,
                    parsed.action,
                    parsed.from_unit,
                    parsed.to_unit,
                    parsed.phase,
                    parsed.metric_name,
                    parsed.metric_value,
                ),
            )
            if cur.rowcount:
                inserted_raw += 1
            event_id = conn.execute("SELECT id FROM raw_events WHERE file_hash=? AND line_no=?", (fhash, line_no)).fetchone()[0]

            if parsed.event_kind in {"interval_start", "interval_end"}:
                pairing_key = compute_pairing_key(row, parsed)
                if parsed.event_kind == "interval_start":
                    conn.execute(
                        "INSERT INTO open_intervals(pairing_key, start_event_id, start_ts) VALUES (?, ?, ?)",
                        (pairing_key, event_id, event_ts),
                    )
                else:
                    open_row = conn.execute(
                        "SELECT id, start_event_id, start_ts FROM open_intervals WHERE pairing_key=? ORDER BY id DESC LIMIT 1",
                        (pairing_key,),
                    ).fetchone()
                    if open_row:
                        open_id, start_event_id, start_ts = open_row
                        duration_ms = _duration_ms(start_ts, event_ts)
                        conn.execute(
                            """
                            INSERT INTO interval_blocks(
                              pairing_key, action, ch, start_event_id, end_event_id, start_ts, end_ts, duration_ms
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                pairing_key,
                                parsed.action,
                                row.get("CH"),
                                start_event_id,
                                event_id,
                                start_ts,
                                event_ts,
                                duration_ms,
                            ),
                        )
                        conn.execute("DELETE FROM open_intervals WHERE id=?", (open_id,))
                        inserted_blocks += 1

    conn.execute(
        "INSERT INTO ingest_files(file_hash, file_path, ingested_at) VALUES (?, ?, datetime('now'))",
        (fhash, str(csv_path)),
    )
    conn.commit()
    conn.close()
    return {
        "status": "ok",
        "file_hash": fhash,
        "raw_events": inserted_raw,
        "interval_blocks": inserted_blocks,
    }


def _duration_ms(start_ts: str, end_ts: str) -> int:
    try:
        s = datetime.fromisoformat(start_ts)
        e = datetime.fromisoformat(end_ts)
        return int((e - s).total_seconds() * 1000)
    except Exception:
        return -1


def query_blocks(db_path: Path, limit: int = 100) -> Iterable[tuple]:
    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        "SELECT action, ch, start_ts, end_ts, duration_ms FROM interval_blocks ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return rows


def query_latest_points(db_path: Path, limit: int = 100) -> Iterable[tuple]:
    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        """
        SELECT event_ts, ch, metric_name, metric_value
        FROM raw_events
        WHERE event_kind IN ('point_metric', 'state_snapshot')
        ORDER BY id DESC LIMIT ?
        """,
        (limit,),
    ).fetchall()
    conn.close()
    return rows

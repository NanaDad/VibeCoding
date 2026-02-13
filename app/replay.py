from __future__ import annotations

import ctypes
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from app.signal_registry import SignalRegistry


@dataclass
class ReplayWrite:
    ts: str
    signal_name: str
    address: int
    value: int
    source_event_id: int


class SharedMemWriter:
    def __init__(self, dll_path: str = r"C:\Windows\ShardMem.dll"):
        self.dll_path = dll_path
        self._fn = None

    def open(self) -> None:
        lib = ctypes.WinDLL(self.dll_path)
        fn = lib.SharedMemPutCommand
        fn.argtypes = [ctypes.c_char, ctypes.c_int, ctypes.c_int]
        fn.restype = None
        self._fn = fn

    def write(self, dev: bytes, address: int, value: int) -> None:
        if not self._fn:
            self.open()
        self._fn(dev, int(address), int(value))


def replay_interval_events(
    db_path: Path,
    registry: SignalRegistry,
    writer: Optional[SharedMemWriter] = None,
    dry_run: bool = True,
    audit_callback: Optional[Callable[[ReplayWrite], None]] = None,
) -> int:
    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        """
        SELECT id, event_ts, action, phase
        FROM raw_events
        WHERE event_kind IN ('interval_start', 'interval_end')
        ORDER BY id ASC
        """
    ).fetchall()
    conn.close()

    count = 0
    for event_id, ts, action, phase in rows:
        cfg = registry.resolve(action or "")
        if not cfg:
            continue
        value = cfg.start_cmd if phase == "START" else cfg.end_cmd
        rec = ReplayWrite(ts=ts, signal_name=cfg.signal_name, address=cfg.d_address, value=value, source_event_id=event_id)
        if audit_callback:
            audit_callback(rec)
        if not dry_run and writer:
            writer.write(b"D", cfg.d_address, value)
        count += 1
    return count

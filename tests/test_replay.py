import sqlite3
from pathlib import Path

from app.replay import replay_interval_events
from app.signal_registry import SignalConfig, SignalRegistry


def test_replay_dry_run_counts_writes(tmp_path: Path):
    db = tmp_path / "t.db"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE raw_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_ts TEXT,
          action TEXT,
          phase TEXT,
          event_kind TEXT
        );
        INSERT INTO raw_events(event_ts, action, phase, event_kind) VALUES
          ('2026-01-01T00:00:00.000','VAC_DV_OPEN','START','interval_start'),
          ('2026-01-01T00:00:01.000','VAC_DV_OPEN','END','interval_end');
        """
    )
    conn.commit()
    conn.close()

    reg = SignalRegistry({"VAC_DV_OPEN": SignalConfig(signal_name="VAC_DV_OPEN", d_address=1200)})
    audit = []
    cnt = replay_interval_events(db, reg, dry_run=True, audit_callback=lambda w: audit.append(w))
    assert cnt == 2
    assert len(audit) == 2
    assert audit[0].address == 1200

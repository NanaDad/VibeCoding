from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.log_pipeline import ingest_csv, query_blocks, query_latest_points
from app.mining import build_dfg_from_blocks, top_bottleneck_edges
from app.replay import replay_interval_events
from app.signal_registry import SignalConfig, SignalRegistry


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Log timeline MVP CLI")
    p.add_argument("--db", default="timeline.db", help="SQLite DB path")
    sub = p.add_subparsers(dest="cmd", required=True)

    ing = sub.add_parser("ingest", help="Ingest a CSV file")
    ing.add_argument("csv", help="Path to CSV")

    bl = sub.add_parser("blocks", help="Show latest interval blocks")
    bl.add_argument("--limit", type=int, default=20)

    pt = sub.add_parser("points", help="Show latest point/state events")
    pt.add_argument("--limit", type=int, default=20)

    ui = sub.add_parser("ui", help="Run DearPyGui UI")
    ui.add_argument("--db", dest="ui_db", default=None, help="DB path override")

    rg = sub.add_parser("registry-init", help="Create a sample signal registry JSON")
    rg.add_argument("path", help="Output json path")

    rp = sub.add_parser("replay", help="Replay interval events to SharedMem DLL (or dry-run)")
    rp.add_argument("--registry", required=True, help="Signal registry json")
    rp.add_argument("--dry-run", action="store_true", default=False)

    mn = sub.add_parser("mining", help="Build simple DFG and bottleneck list")
    mn.add_argument("--top", type=int, default=10)

    return p


def main() -> None:
    args = build_parser().parse_args()
    db_path = Path(args.db)

    if args.cmd == "ingest":
        result = ingest_csv(Path(args.csv), db_path)
        print(result)
    elif args.cmd == "blocks":
        for row in query_blocks(db_path, args.limit):
            print(row)
    elif args.cmd == "points":
        for row in query_latest_points(db_path, args.limit):
            print(row)
    elif args.cmd == "ui":
        from app.ui_dpg import run_ui

        run_ui(Path(args.ui_db) if args.ui_db else db_path)
    elif args.cmd == "registry-init":
        registry = SignalRegistry(
            {
                "VAC_DV_OPEN": SignalConfig(signal_name="VAC_DV_OPEN", object_type="valve", channel="LL01", d_address=1200),
                "PLATEN_DOWN": SignalConfig(signal_name="PLATEN_DOWN", object_type="actuator", channel="PC03", d_address=1300),
            }
        )
        out = Path(args.path)
        registry.save(out)
        print(f"saved: {out}")
    elif args.cmd == "replay":
        registry = SignalRegistry.load(Path(args.registry))
        audits = []
        count = replay_interval_events(db_path, registry, dry_run=args.dry_run, audit_callback=lambda x: audits.append(x.__dict__))
        print({"writes": count, "dry_run": args.dry_run, "audit_preview": audits[:5]})
    elif args.cmd == "mining":
        dfg = build_dfg_from_blocks(db_path)
        top = top_bottleneck_edges(dfg, top_n=args.top)
        print(json.dumps({"edges": [{"from": a, "to": b, "count": c, "avg_next_duration_ms": d} for a, b, c, d in top]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

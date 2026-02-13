from __future__ import annotations

import json
from pathlib import Path

from app.log_pipeline import ingest_csv, query_blocks, query_latest_points
from app.replay import replay_interval_events
from app.signal_registry import SignalRegistry


def to_state_color(state_text: str) -> tuple[int, int, int, int]:
    s = (state_text or "").upper()
    if s == "ON":
        return (30, 180, 80, 255)
    if s == "OFF":
        return (210, 60, 60, 255)
    return (180, 180, 180, 255)


def run_ui(db_path: Path) -> None:
    try:
        import dearpygui.dearpygui as dpg
    except Exception as exc:
        raise RuntimeError("DearPyGui is not installed. Install with: pip install dearpygui") from exc

    dpg.create_context()

    app_state = {
        "db_path": str(db_path),
        "zoom_history": [],
        "measure_a": None,
        "measure_b": None,
        "registry_path": "registry.json",
        "signal_rows": {},  # name -> {state_tag,value_tag}
    }

    def ensure_signal_row(signal_name: str):
        if signal_name in app_state["signal_rows"]:
            return
        row_tag = f"sig_row::{signal_name}"
        state_tag = f"sig_state::{signal_name}"
        value_tag = f"sig_value::{signal_name}"
        with dpg.table_row(parent="signal_table", tag=row_tag):
            dpg.add_text(signal_name)
            dpg.add_text("-", tag=state_tag)
            dpg.add_text("-", tag=value_tag)
        app_state["signal_rows"][signal_name] = {"state_tag": state_tag, "value_tag": value_tag}

    def update_signal_monitor(signal_name: str, state_text: str | None = None, value_text: str | None = None):
        ensure_signal_row(signal_name)
        row = app_state["signal_rows"][signal_name]
        if state_text is not None:
            dpg.set_value(row["state_tag"], state_text)
            dpg.configure_item(row["state_tag"], color=to_state_color(state_text))
        if value_text is not None:
            dpg.set_value(row["value_tag"], value_text)

    def refresh_tables() -> None:
        dpg.delete_item("blocks_table", children_only=True)
        dpg.delete_item("points_table", children_only=True)

        for action, ch, start_ts, end_ts, duration_ms in query_blocks(Path(app_state["db_path"]), limit=50):
            with dpg.table_row(parent="blocks_table"):
                dpg.add_text(action)
                dpg.add_text(ch)
                dpg.add_text(start_ts)
                dpg.add_text(end_ts)
                dpg.add_text(str(duration_ms))

        for event_ts, ch, metric_name, metric_value in query_latest_points(Path(app_state["db_path"]), limit=100):
            with dpg.table_row(parent="points_table"):
                dpg.add_text(event_ts)
                dpg.add_text(ch)
                dpg.add_text(metric_name)
                dpg.add_text(str(metric_value))

            # point/state 값을 시그널 모니터 Value 영역에 반영
            if metric_name:
                update_signal_monitor(metric_name, value_text=str(metric_value))

    def on_csv_selected(sender, app_data):
        selected = app_data.get("selections") if isinstance(app_data, dict) else None
        if not selected:
            return
        csv_path = Path(next(iter(selected.values())))
        result = ingest_csv(csv_path, Path(app_state["db_path"]))
        dpg.set_value("status_text", str(result))
        refresh_tables()

    def on_set_measure_a():
        x = dpg.get_value("cursor_x")
        app_state["measure_a"] = x
        dpg.set_value("measure_text", f"A set: {x:.3f}")

    def on_set_measure_b():
        x = dpg.get_value("cursor_x")
        app_state["measure_b"] = x
        if app_state["measure_a"] is not None:
            dt = abs(app_state["measure_b"] - app_state["measure_a"])
            dpg.set_value("measure_text", f"Δt: {dt:.3f}")

    def on_key_press(sender, app_data):
        if app_data == dpg.mvKey_Escape:
            dpg.set_value("status_text", "ESC pressed: zoom reset requested")

    def on_registry_pick(sender, app_data):
        selected = app_data.get("selections") if isinstance(app_data, dict) else None
        if not selected:
            return
        path = Path(next(iter(selected.values())))
        app_state["registry_path"] = str(path)
        dpg.set_value("registry_path_text", app_state["registry_path"])

    def on_replay_dry_run():
        reg_path = Path(app_state["registry_path"])
        registry = SignalRegistry.load(reg_path)
        seen = 0

        def audit(write):
            nonlocal seen
            seen += 1
            # START=ON, END=OFF 표시
            if write.value == 1:
                state = "ON"
            elif write.value == 0:
                state = "OFF"
            else:
                state = "VALUE"
            update_signal_monitor(write.signal_name, state_text=state, value_text=str(write.value))
            dpg.set_value("last_write_text", f"last: {write.signal_name} addr={write.address} value={write.value} ts={write.ts}")

        count = replay_interval_events(Path(app_state["db_path"]), registry, dry_run=True, audit_callback=audit)
        dpg.set_value("status_text", f"replay dry-run writes={count}, monitored={seen}")

    def on_export_signal_snapshot():
        snapshot = {}
        for name, tags in app_state["signal_rows"].items():
            snapshot[name] = {
                "state": dpg.get_value(tags["state_tag"]),
                "value": dpg.get_value(tags["value_tag"]),
            }
        out = Path("signal_snapshot.json")
        out.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
        dpg.set_value("status_text", f"signal snapshot saved: {out}")

    with dpg.file_dialog(directory_selector=False, show=False, callback=on_csv_selected, tag="csv_dialog", width=700, height=400):
        dpg.add_file_extension(".csv", color=(150, 255, 150, 255))

    with dpg.file_dialog(directory_selector=False, show=False, callback=on_registry_pick, tag="registry_dialog", width=700, height=400):
        dpg.add_file_extension(".json", color=(150, 200, 255, 255))

    with dpg.window(label="Log Timeline MVP", width=1460, height=900):
        with dpg.group(horizontal=True):
            # Main area
            with dpg.child_window(width=980, height=860):
                dpg.add_text("Step2~6 MVP UI")
                dpg.add_button(label="CSV 열기", callback=lambda: dpg.show_item("csv_dialog"))
                dpg.add_same_line()
                dpg.add_button(label="Registry 열기", callback=lambda: dpg.show_item("registry_dialog"))
                dpg.add_same_line()
                dpg.add_button(label="Replay Dry-Run", callback=on_replay_dry_run)
                dpg.add_same_line()
                dpg.add_button(label="Signal Snapshot 저장", callback=on_export_signal_snapshot)

                dpg.add_text("status", tag="status_text")
                dpg.add_text(f"registry: {app_state['registry_path']}", tag="registry_path_text")
                dpg.add_text("last write: -", tag="last_write_text")

                dpg.add_separator()
                dpg.add_text("Crosshair/Measure")
                dpg.add_slider_float(label="cursor_x", tag="cursor_x", min_value=0.0, max_value=100000.0, default_value=0.0)
                dpg.add_button(label="A 지점", callback=on_set_measure_a)
                dpg.add_same_line()
                dpg.add_button(label="B 지점", callback=on_set_measure_b)
                dpg.add_text("Δt: -", tag="measure_text")

                dpg.add_separator()
                dpg.add_text("Interval Blocks")
                with dpg.table(tag="blocks_table", header_row=True, resizable=True):
                    dpg.add_table_column(label="action")
                    dpg.add_table_column(label="ch")
                    dpg.add_table_column(label="start")
                    dpg.add_table_column(label="end")
                    dpg.add_table_column(label="duration_ms")

                dpg.add_separator()
                dpg.add_text("Point/State")
                with dpg.table(tag="points_table", header_row=True, resizable=True):
                    dpg.add_table_column(label="event_ts")
                    dpg.add_table_column(label="ch")
                    dpg.add_table_column(label="metric")
                    dpg.add_table_column(label="value")

            # Signal monitor side panel (세로로 긴 창)
            with dpg.child_window(width=440, height=860):
                dpg.add_text("ShardMem Signal Monitor")
                dpg.add_text("Name | State(ON/OFF) | Value")
                with dpg.table(tag="signal_table", header_row=True, resizable=True):
                    dpg.add_table_column(label="Name")
                    dpg.add_table_column(label="State")
                    dpg.add_table_column(label="Value")

    with dpg.handler_registry():
        dpg.add_key_press_handler(callback=on_key_press)

    refresh_tables()
    dpg.create_viewport(title="Log Timeline MVP", width=1460, height=900)
    dpg.setup_dearpygui()
    dpg.show_viewport()
    dpg.start_dearpygui()
    dpg.destroy_context()

from app.log_pipeline import parse_descript


def test_parse_interval_start():
    p = parse_descript("PLATEN_DOWN=PC03=PC03=START")
    assert p.event_kind == "interval_start"
    assert p.action == "PLATEN_DOWN"
    assert p.from_unit == "PC03"
    assert p.to_unit == "PC03"


def test_parse_point_metric():
    p = parse_descript("MFC31=70.00")
    assert p.event_kind == "point_metric"
    assert p.metric_name == "MFC31"
    assert p.metric_value == 70.0


def test_parse_state_snapshot_fallback():
    p = parse_descript("SOME=UNKNOWN=STATE")
    assert p.event_kind == "state_snapshot"

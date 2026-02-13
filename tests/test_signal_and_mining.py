from pathlib import Path

from app.mining import top_bottleneck_edges
from app.signal_registry import SignalConfig, SignalRegistry


def test_signal_registry_roundtrip(tmp_path: Path):
    p = tmp_path / "registry.json"
    reg = SignalRegistry({"A": SignalConfig(signal_name="A", d_address=100)})
    reg.save(p)
    loaded = SignalRegistry.load(p)
    assert loaded.resolve("A") is not None
    assert loaded.resolve("A").d_address == 100


def test_top_bottleneck_edges_sorting():
    dfg = {
        ("A", "B"): {"count": 2, "avg_next_duration_ms": 50},
        ("B", "C"): {"count": 5, "avg_next_duration_ms": 40},
        ("C", "D"): {"count": 1, "avg_next_duration_ms": 100},
    }
    top = top_bottleneck_edges(dfg, top_n=2)
    assert top[0][0] == "C"
    assert top[0][1] == "D"
    assert len(top) == 2

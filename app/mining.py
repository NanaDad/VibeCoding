from __future__ import annotations

import sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, List, Tuple


DFGEdge = Tuple[str, str]


def build_dfg_from_blocks(db_path: Path, lane_field: str = "ch") -> Dict[DFGEdge, dict]:
    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        f"SELECT {lane_field}, action, start_ts, end_ts, duration_ms FROM interval_blocks ORDER BY start_ts"
    ).fetchall()
    conn.close()

    per_lane: Dict[str, List[tuple]] = defaultdict(list)
    for lane, action, start_ts, end_ts, duration_ms in rows:
        per_lane[lane or ""] .append((action or "", start_ts, end_ts, duration_ms))

    edge_counts: Counter[DFGEdge] = Counter()
    edge_duration: Dict[DFGEdge, List[int]] = defaultdict(list)

    for _, seq in per_lane.items():
        for prev, nxt in zip(seq, seq[1:]):
            a, _, _, _ = prev
            b, _, _, d = nxt
            edge = (a, b)
            edge_counts[edge] += 1
            if isinstance(d, int):
                edge_duration[edge].append(d)

    result = {}
    for edge, cnt in edge_counts.items():
        durations = edge_duration.get(edge, [])
        avg = sum(durations) / len(durations) if durations else 0.0
        result[edge] = {"count": cnt, "avg_next_duration_ms": round(avg, 3)}
    return result


def top_bottleneck_edges(dfg: Dict[DFGEdge, dict], top_n: int = 10) -> List[tuple]:
    edges = [(edge[0], edge[1], v["count"], v["avg_next_duration_ms"]) for edge, v in dfg.items()]
    edges.sort(key=lambda x: (x[3], x[2]), reverse=True)
    return edges[:top_n]

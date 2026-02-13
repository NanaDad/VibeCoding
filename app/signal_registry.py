from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, Optional


@dataclass
class SignalConfig:
    signal_name: str
    object_type: str = "generic"
    channel: str = ""
    d_address: int = 0
    start_cmd: int = 1
    end_cmd: int = 0
    metric_scale: float = 1.0


class SignalRegistry:
    def __init__(self, signals: Optional[Dict[str, SignalConfig]] = None):
        self.signals: Dict[str, SignalConfig] = signals or {}

    def resolve(self, signal_name: str) -> Optional[SignalConfig]:
        return self.signals.get(signal_name)

    def upsert(self, cfg: SignalConfig) -> None:
        self.signals[cfg.signal_name] = cfg

    def to_json(self) -> str:
        payload = {k: asdict(v) for k, v in self.signals.items()}
        return json.dumps(payload, ensure_ascii=False, indent=2)

    @classmethod
    def from_json(cls, text: str) -> "SignalRegistry":
        raw = json.loads(text) if text.strip() else {}
        mapped = {k: SignalConfig(**v) for k, v in raw.items()}
        return cls(mapped)

    @classmethod
    def load(cls, path: Path) -> "SignalRegistry":
        if not path.exists():
            return cls()
        return cls.from_json(path.read_text(encoding="utf-8"))

    def save(self, path: Path) -> None:
        path.write_text(self.to_json(), encoding="utf-8")

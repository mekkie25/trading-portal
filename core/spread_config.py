"""
core/spread_config.py
Single source of truth for broker spread values.

Loads config/spread_config.json. Each symbol entry may contain:

    spread          -- all-in spread in price terms (raw spread plus commission
                       converted to price). Used by the simulator and by the
                       live execution engine.
    filter_spread   -- optional. If present, the strategy manager's
                       SPREAD_IN_R filter uses this value instead of spread.
                       If absent, the filter falls back to spread.

load_spreads() returns {symbol: value used by the SPREAD_IN_R filter}.
That value is filter_spread when present, else spread.
Symbols missing from the JSON are filled from the built-in fallback so
behaviour matches the old hard-coded table on a fresh checkout.
"""

import os
import json
from typing import Any, Dict, Optional


_DEFAULTS: Dict[str, float] = {
    "GOLD":     0.30,
    "US30":     2.50,
    "NAS100":   1.50,
    "GERMAN30": 1.80,
    "EURUSD":   0.00010,
    "USDJPY":   0.012,
    "GBPUSD":   0.00014,
}

_RAW_CACHE: Optional[Dict[str, Any]] = None


def _config_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, ".."))
    return os.path.join(root, "config", "spread_config.json")


def _load_raw(force_reload: bool = False) -> Dict[str, Any]:
    global _RAW_CACHE
    if _RAW_CACHE is not None and not force_reload:
        return _RAW_CACHE

    path = _config_path()
    if not os.path.exists(path):
        _RAW_CACHE = {}
        return _RAW_CACHE
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read().strip()
        if not raw:
            _RAW_CACHE = {}
            return _RAW_CACHE
        parsed = json.loads(raw)
        _RAW_CACHE = parsed if isinstance(parsed, dict) else {}
    except Exception as e:
        print(f"[spread_config] could not read {path}: {e}", flush=True)
        _RAW_CACHE = {}
    return _RAW_CACHE


def load_spreads(force_reload: bool = False) -> Dict[str, float]:
    raw = _load_raw(force_reload=force_reload)
    out: Dict[str, float] = dict(_DEFAULTS)

    symbols = raw.get("symbols") if isinstance(raw, dict) else None
    if isinstance(symbols, dict):
        for sym, entry in symbols.items():
            try:
                key = str(sym).upper()
                if isinstance(entry, dict):
                    val = entry.get("filter_spread")
                    if val is None:
                        val = entry.get("spread")
                else:
                    val = entry
                if val is None:
                    continue
                out[key] = float(val)
            except (TypeError, ValueError):
                continue

    return out


def reload_spreads() -> Dict[str, float]:
    return load_spreads(force_reload=True)
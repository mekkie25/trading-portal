"""
core/spread_config.py
Loads the broker spread configuration from config/spread_config.json.

This module is imported by backtest/simulator.py and engine/matrix.py at
import time. It exposes one function, load_spreads(), which returns a
flat {symbol: spread} dictionary in price terms.

The JSON file lives at config/spread_config.json and is edited by the
Backtest panel's "Spreads" tab or by hand. If the file is missing or
malformed, load_spreads() returns a small built-in fallback so the
engine can still start.
"""

import os
import json
from typing import Dict


# Built-in fallback if the JSON file is missing or unreadable.
_FALLBACK: Dict[str, float] = {
    "GOLD":     0.225,
    "US30":     1.00,
    "NAS100":   0.80,
    "GERMAN30": 1.20,
    "EURUSD":   0.00005,
    "USDJPY":   0.0053,
    "GBPUSD":   0.000061,
}

_SPREADS_CACHE: Dict[str, float] = {}


def _config_path() -> str:
    """Resolve the path to config/spread_config.json from this file's location."""
    here = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(here, ".."))
    return os.path.join(project_root, "config", "spread_config.json")


def load_spreads(force_reload: bool = False) -> Dict[str, float]:
    """
    Returns a flat dict of {symbol: spread} loaded from
    config/spread_config.json. Each entry's "spread" field becomes the
    value. Symbols that are missing or have an invalid spread are
    omitted, and the fallback value is used for any standard symbol
    that is missing.

    Results are cached. Pass force_reload=True to re-read the file.
    """
    global _SPREADS_CACHE
    if _SPREADS_CACHE and not force_reload:
        return dict(_SPREADS_CACHE)

    path = _config_path()
    out: Dict[str, float] = dict(_FALLBACK)

    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                raw = f.read().strip()
            if raw:
                parsed = json.loads(raw)
                symbols = parsed.get("symbols") or {}
                for sym, entry in symbols.items():
                    try:
                        if isinstance(entry, dict):
                            val = entry.get("spread")
                        else:
                            val = entry
                        if val is None:
                            continue
                        out[str(sym).upper()] = float(val)
                    except (TypeError, ValueError):
                        continue
    except Exception as e:
        print(f"[spread_config] could not load {path}: {e}; using fallback.", flush=True)

    _SPREADS_CACHE = dict(out)
    return dict(out)


def reload_spreads() -> Dict[str, float]:
    """Force a fresh read. Useful after the Spreads panel saves a new config."""
    return load_spreads(force_reload=True)
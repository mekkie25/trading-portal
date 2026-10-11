"""
core/pair_settings.py
Per-pair, per-strategy settings: loader and applier.

Defaults reproduce today's behaviour exactly: every strategy enabled, no
time window, no weekday filter, no stop-size bounds, no spread cap, no R:R
override, no break-even override, no daily-cap override.

Nothing in this file is part of the backtest signal cache hash. The JSON
file it reads is also not part of the hash, so editing the settings does
not cold-start the cache.

PROPOSED.
"""

import os
import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

try:
    from core.session_config import TZ_SAST
except ImportError:
    from zoneinfo import ZoneInfo
    TZ_SAST = ZoneInfo("Africa/Johannesburg")


WHITELIST_PAIRS = ["US30", "GOLD", "NAS100", "GERMAN30", "EURUSD", "GBPUSD", "USDJPY"]

STRATEGY_NAMES = [
    "GRUBBER_KICK",
    "STRATEGY_513",
    "ORB_LIQUIDITY_SWEEP",
    "AVWAP_200EMA_CONTINUATION",
    "PDH_PDL_FAILED_BREAKOUT",
    "EMA_9_25_CROSS",
    "ORB_CRACKER",
    "OES_4H_ORDER_BLOCK",
]

# Half-open [start_hour, end_hour) on the SAST clock.
SESSION_BLOCKS: Dict[str, Tuple[int, int]] = {
    "ASIA":         (1, 6),
    "LONDON":       (8, 15),
    "LONDON_NY":    (15, 17),
    "NY":           (17, 23),
    "ALL_DAY":      (0, 24),
}

DEFAULT_STRATEGY_SETTINGS: Dict[str, Any] = {
    "enabled": True,
    "session_window_sast": None,
    "weekdays": None,
    "min_stop_atr": 0.0,
    "max_stop_atr": None,
    "max_spread_in_r": None,
    "rr": None,
    "be_enabled": None,
    "max_daily_trades": None,
}


def _blank_strategy_settings() -> Dict[str, Any]:
    return dict(DEFAULT_STRATEGY_SETTINGS)


def _blank_pair_settings() -> Dict[str, Any]:
    return {
        "live_enabled": True,
        "risk_pct": None,
        "strategies": {s: _blank_strategy_settings() for s in STRATEGY_NAMES},
    }


def default_settings() -> Dict[str, Any]:
    return {"pairs": {p: _blank_pair_settings() for p in WHITELIST_PAIRS}}


def _settings_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, ".."))
    return os.path.join(root, "config", "pair_settings.json")


def _merge_strategy(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    for k in DEFAULT_STRATEGY_SETTINGS:
        if k in override:
            out[k] = override[k]
    return out


def _merge_pair(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    out = {
        "live_enabled": override.get("live_enabled", base["live_enabled"]),
        "risk_pct": override.get("risk_pct", base["risk_pct"]),
        "strategies": {},
    }
    strat_overrides = override.get("strategies") or {}
    for s in STRATEGY_NAMES:
        out["strategies"][s] = _merge_strategy(
            base["strategies"][s], strat_overrides.get(s) or {}
        )
    return out


def normalise_settings(raw: Dict[str, Any]) -> Dict[str, Any]:
    base = default_settings()
    pairs_raw = (raw or {}).get("pairs") or {}
    out = {"pairs": {}}
    for p in WHITELIST_PAIRS:
        out["pairs"][p] = _merge_pair(base["pairs"][p], pairs_raw.get(p) or {})
    return out


def load_pair_settings(path: Optional[str] = None) -> Dict[str, Any]:
    """Reads config/pair_settings.json. Missing/unreadable => defaults."""
    if path is None:
        path = _settings_path()
    if not os.path.exists(path):
        return default_settings()
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read().strip()
        if not content:
            return default_settings()
        raw = json.loads(content)
        if not isinstance(raw, dict):
            return default_settings()
        return normalise_settings(raw)
    except Exception as e:
        print(f"[pair_settings] could not read {path}: {e}; using defaults.", flush=True)
        return default_settings()


def save_pair_settings(settings: Dict[str, Any], path: Optional[str] = None) -> bool:
    if path is None:
        path = _settings_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2)
        os.replace(tmp, path)
        return True
    except Exception as e:
        print(f"[pair_settings] could not write {path}: {e}", flush=True)
        try:
            if os.path.exists(path + ".tmp"):
                os.remove(path + ".tmp")
        except OSError:
            pass
        return False


def get_strategy_settings(settings: Dict[str, Any], pair: str, strategy: str) -> Dict[str, Any]:
    pairs = settings.get("pairs") or {}
    pair_block = pairs.get(pair) or {}
    strat_map = pair_block.get("strategies") or {}
    s = strat_map.get(strategy)
    if s is None:
        return _blank_strategy_settings()
    return _merge_strategy(_blank_strategy_settings(), s)


def get_pair_settings(settings: Dict[str, Any], pair: str) -> Dict[str, Any]:
    pairs = settings.get("pairs") or {}
    block = pairs.get(pair)
    if block is None:
        return _blank_pair_settings()
    return block


def _resolve_session_hours(window: Any) -> Optional[Tuple[int, int]]:
    if window is None:
        return None
    if isinstance(window, str):
        return SESSION_BLOCKS.get(window)
    if isinstance(window, (list, tuple)) and len(window) == 2:
        try:
            return int(window[0]), int(window[1])
        except (TypeError, ValueError):
            return None
    if isinstance(window, dict):
        try:
            return int(window.get("start")), int(window.get("end"))
        except (TypeError, ValueError):
            return None
    return None


def passes_signal_filters(
    strategy_settings: Dict[str, Any],
    signal: Any,
    entry_time: Optional[datetime],
    atr14: float,
    spread: float,
) -> Tuple[bool, str]:
    """
    Returns (True, "") if the signal may open, (False, reason) if not.
    Never raises.
    """
    try:
        if not bool(strategy_settings.get("enabled", True)):
            return False, "SETTING_DISABLED"

        if entry_time is not None:
            if entry_time.tzinfo is None:
                entry_time = entry_time.replace(tzinfo=timezone.utc)
            sast = entry_time.astimezone(TZ_SAST)

            hours = _resolve_session_hours(strategy_settings.get("session_window_sast"))
            if hours is not None:
                start_h, end_h = hours
                h = sast.hour
                if start_h <= end_h:
                    ok = start_h <= h < end_h
                else:
                    ok = h >= start_h or h < end_h
                if not ok:
                    return False, "SETTING_SESSION"

            wd = strategy_settings.get("weekdays")
            if wd is not None:
                try:
                    allowed = {int(x) for x in wd}
                except (TypeError, ValueError):
                    allowed = None
                if allowed is not None and sast.weekday() not in allowed:
                    return False, "SETTING_WEEKDAY"

        try:
            sl_dist = abs(float(signal.entry_price) - float(signal.stop_loss))
        except (TypeError, ValueError):
            sl_dist = 0.0

        if atr14 and atr14 > 0 and sl_dist > 0:
            stop_atr = sl_dist / atr14
            min_s = strategy_settings.get("min_stop_atr")
            if min_s is not None:
                try:
                    min_s = float(min_s)
                except (TypeError, ValueError):
                    min_s = 0.0
                if min_s > 0 and stop_atr < min_s:
                    return False, "SETTING_MIN_STOP"
            max_s = strategy_settings.get("max_stop_atr")
            if max_s is not None:
                try:
                    max_s = float(max_s)
                except (TypeError, ValueError):
                    max_s = None
                if max_s is not None and max_s > 0 and stop_atr > max_s:
                    return False, "SETTING_MAX_STOP"

        max_sp = strategy_settings.get("max_spread_in_r")
        if max_sp is not None and sl_dist > 0:
            try:
                max_sp = float(max_sp)
            except (TypeError, ValueError):
                max_sp = None
            if max_sp is not None and max_sp > 0:
                if (float(spread) / sl_dist) > max_sp:
                    return False, "SETTING_SPREAD"

        return True, ""
    except Exception:
        return True, ""


def get_effective_rr(strategy_settings: Dict[str, Any], default_rr: float) -> float:
    r = strategy_settings.get("rr")
    if r is None:
        return float(default_rr)
    try:
        return float(r)
    except (TypeError, ValueError):
        return float(default_rr)


def get_effective_be(strategy_settings: Dict[str, Any], default_be: bool) -> bool:
    v = strategy_settings.get("be_enabled")
    if v is None:
        return bool(default_be)
    return bool(v)


def get_effective_max_daily(strategy_settings: Dict[str, Any], default_max: int) -> Optional[int]:
    v = strategy_settings.get("max_daily_trades")
    if v is None:
        return None  # caller uses its own default
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
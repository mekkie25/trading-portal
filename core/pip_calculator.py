"""
core/pip_calculator.py
Derives per-(pair, strategy) minimum SL pip distances from the last
backtest's trade list, and writes config/pip_calculator.json.

Algorithm:
  For each pair and strategy with >= MIN_TRADES trades:
    sl_pips      = median structural SL distance (in pips)
    post_sl_R    = median of (post_sl_cont_pips / sl_pips) from §16-equivalent
    sl_factor    = 1.0 + min(post_sl_R, MAX_WIDENING)
    min_sl_pips  = sl_pips * sl_factor
  For strategies under MIN_TRADES: use the pair-level median.
  If the pair total is also under MIN_TRADES: skip the pair entirely.

The simulator reads this file at startup and uses min_sl_pips as a
FLOOR: if the strategy's structural SL is tighter than the floor, the
simulator widens the SL to the floor. If the structural SL is already
wider, it is kept. TP is then derived from the (possibly widened) SL
by the normal fixed R:R logic. This preserves structural stops while
fixing the "SL too tight on noise" problem measured in §16.

CHANGES 2026-10-13
------------------
- Added effective_min_stop_pips(), the combined min-stop floor used by
  both backtest/simulator.py and engine/matrix.py so the live bot and the
  backtest place identical stops.
"""

import os
import json
import statistics
from typing import Dict, Any, List, Optional


MIN_TRADES = 30
MAX_WIDENING = 2.0   # sl_factor is capped at 1 + 2.0 = 3.0
OUTPUT_FILE = "pip_calculator.json"


def _config_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, ".."))
    return os.path.join(root, "config", OUTPUT_FILE)


def _safe_median(values: List[float]) -> Optional[float]:
    vals = [v for v in values if v is not None and v > 0]
    if not vals:
        return None
    try:
        return float(statistics.median(vals))
    except Exception:
        return None


def _sl_pips(trade: Dict[str, Any]) -> Optional[float]:
    try:
        entry = float(trade.get("entry_price", 0.0))
        sl = float(trade.get("sl", 0.0))
        pip = float(trade.get("pip_size", 0.0) or 0.0)
    except (TypeError, ValueError):
        return None
    if pip <= 0 or entry <= 0:
        return None
    dist = abs(entry - sl)
    if dist <= 0:
        return None
    return dist / pip


def _post_sl_R(trade: Dict[str, Any]) -> Optional[float]:
    if trade.get("result") != "LOSS":
        return None
    cont = trade.get("post_sl_cont_pips")
    if cont is None:
        return None
    try:
        cont_pips = float(cont)
    except (TypeError, ValueError):
        return None
    slp = _sl_pips(trade)
    if slp is None or slp <= 0:
        return None
    return cont_pips / slp


def _compute_for_group(trades: List[Dict[str, Any]]) -> Optional[Dict[str, float]]:
    sl_list: List[float] = []
    post_sl_list: List[float] = []
    for t in trades:
        slp = _sl_pips(t)
        if slp is not None:
            sl_list.append(slp)
        pr = _post_sl_R(t)
        if pr is not None:
            post_sl_list.append(pr)

    base_sl = _safe_median(sl_list)
    if base_sl is None or base_sl <= 0:
        return None

    post_sl_med = _safe_median(post_sl_list) or 0.0
    sl_factor = 1.0 + min(post_sl_med, MAX_WIDENING)
    min_sl = base_sl * sl_factor

    return {
        "base_sl_pips": round(base_sl, 2),
        "post_sl_R": round(post_sl_med, 3),
        "sl_factor": round(sl_factor, 3),
        "min_sl_pips": round(min_sl, 2),
        "sample_trades": len(trades),
    }


def build_pip_calculator(trades: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    trades: a flat list of every trade from every pair, each with symbol,
    strategy, result, entry_price, sl, pip_size, post_sl_cont_pips.
    """
    by_pair: Dict[str, List[Dict[str, Any]]] = {}
    by_pair_strat: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}

    for t in trades:
        if not isinstance(t, dict):
            continue
        pair = str(t.get("symbol", "")).upper()
        strat = str(t.get("strategy", "UNKNOWN"))
        if not pair:
            continue
        by_pair.setdefault(pair, []).append(t)
        by_pair_strat.setdefault(pair, {}).setdefault(strat, []).append(t)

    out: Dict[str, Any] = {"pairs": {}}

    for pair, pair_trades in by_pair.items():
        pair_level = _compute_for_group(pair_trades)
        pair_entry: Dict[str, Any] = {"pair_level": pair_level, "strategies": {}}

        for strat, s_trades in by_pair_strat[pair].items():
            if len(s_trades) >= MIN_TRADES:
                entry = _compute_for_group(s_trades)
                if entry:
                    entry["source"] = "per_strategy"
                    pair_entry["strategies"][strat] = entry
            else:
                if pair_level:
                    fallback = dict(pair_level)
                    fallback["source"] = "pair_fallback"
                    fallback["strategy_sample_trades"] = len(s_trades)
                    pair_entry["strategies"][strat] = fallback

        if pair_level or pair_entry["strategies"]:
            out["pairs"][pair] = pair_entry

    return out


def write_pip_calculator(trades: List[Dict[str, Any]]) -> bool:
    try:
        payload = build_pip_calculator(trades)
        path = _config_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp, path)
        return True
    except Exception as e:
        print(f"[pip_calculator] write failed: {e}", flush=True)
        return False


def load_pip_calculator() -> Optional[Dict[str, Any]]:
    path = _config_path()
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def min_sl_pips_for(payload: Optional[Dict[str, Any]], pair: str, strategy: str) -> Optional[float]:
    if not payload:
        return None
    try:
        pair_block = (payload.get("pairs") or {}).get(pair.upper())
        if not pair_block:
            return None
        strat_block = (pair_block.get("strategies") or {}).get(strategy)
        if strat_block and strat_block.get("min_sl_pips"):
            return float(strat_block["min_sl_pips"])
        pl = pair_block.get("pair_level")
        if pl and pl.get("min_sl_pips"):
            return float(pl["min_sl_pips"])
    except Exception:
        return None
    return None


def effective_min_stop_pips(
    symbol: str,
    strategy: str,
    payload: Optional[Dict[str, Any]] = None,
) -> float:
    """
    Combined minimum stop floor in pips. This is what backtest/simulator.py
    and engine/matrix.py both call so the live bot and the backtest place
    identical stops.

    Returns max of:
      - GLOBAL_PARAMS.min_stop_pips[symbol]                 (hardcoded floor)
      - min_sl_pips_for(payload, symbol, strategy)          (data-driven floor
                                                             from the last
                                                             backtest via
                                                             config/pip_calculator.json)

    If no floor is available from either source, returns 0.0, which means
    "no floor" and the caller leaves the structural stop untouched.
    """
    # Lazy import avoids a circular dependency at module load time
    # (session_config imports nothing from here, but the simulator imports
    # this module before session_config has fully initialized in some paths).
    try:
        from core.session_config import GLOBAL_PARAMS
    except Exception:
        GLOBAL_PARAMS = None

    hardcoded = 0.0
    if GLOBAL_PARAMS is not None:
        try:
            table = getattr(GLOBAL_PARAMS, "min_stop_pips", {}) or {}
            hardcoded = float(table.get(str(symbol).upper(), 0.0) or 0.0)
        except Exception:
            hardcoded = 0.0

    data_driven = 0.0
    try:
        v = min_sl_pips_for(payload, symbol, strategy)
        if v is not None:
            data_driven = float(v)
    except Exception:
        data_driven = 0.0

    return max(hardcoded, data_driven)
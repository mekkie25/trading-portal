"""
core/pip_calculator.py

Self-tuning per-(pair, strategy) minimum stop floor.

Produces config/pip_calculator.json. Read by backtest/simulator.py and
engine/matrix.py. The effective floor at runtime is:

    effective_min_stop_pips = max(
        GLOBAL_PARAMS.min_stop_pips[pair],
        pip_calculator.min_sl_pips[pair][strategy],
    )

ALGORITHM (v2.0)

  For each pair and strategy with >= MIN_TRADES trades:
    base_sl_pips      = median of the actual stop distances (in pips)
    post_sl_pips_med  = median of post_sl_cont_pips across losing trades
    raw_floor         = max(base_sl_pips, FLOOR_FRACTION * post_sl_pips_med)
    min_sl_pips       = min(raw_floor, MAX_FLOOR_MULTIPLE * base_sl_pips)

  Where:
    FLOOR_FRACTION     = 0.5  (only half the noise band, to be conservative)
    MAX_FLOOR_MULTIPLE = 1.5  (never widen a stop by more than 50%)

  Strategies under MIN_TRADES fall back to the pair-level value.
  Pairs under MIN_TRADES are omitted entirely.

WHY THIS VERSION IS STABLE

  The previous formula used:
    sl_factor = 1.0 + min(post_sl_R, MAX_WIDENING)
    min_sl = base_sl * sl_factor
  where post_sl_R = post_sl_cont_pips / base_sl_pips.

  Expanding: min_sl = base_sl + post_sl_cont_pips.

  That LOOKS stable, but the input post_sl_cont_pips is measured on trades
  whose stops were set by the PREVIOUS run. Widening the stop changes the
  sample, which changes post_sl_cont_pips, which changes min_sl again. On
  the next run it widens further. This is the runaway behaviour observed in
  the previous two runs.

  v2.0 breaks the loop in two ways:
    1. Uses raw pips, not R units, so the two inputs are dimensionally
       independent.
    2. Hard caps the widening at 1.5x. Even if the sample misbehaves, the
       floor can only ever double-and-a-half the stop.

  The formula_version field in the payload causes any stale v1.x payload
  to be silently ignored by load_pip_calculator().
"""

import os
import json
import statistics
from typing import Dict, Any, List, Optional


PIP_CALC_FORMULA_VERSION = "2.0"
MIN_TRADES = 30
FLOOR_FRACTION = 0.5
MAX_FLOOR_MULTIPLE = 1.5
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
    """Structural stop distance of the trade, in pips."""
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


def _post_sl_pips(trade: Dict[str, Any]) -> Optional[float]:
    """Post-stop continuation distance, in pips. Only meaningful on losses."""
    if trade.get("result") != "LOSS":
        return None
    cont = trade.get("post_sl_cont_pips")
    if cont is None:
        return None
    try:
        v = float(cont)
    except (TypeError, ValueError):
        return None
    return v if v >= 0 else None


def _compute_for_group(trades: List[Dict[str, Any]]) -> Optional[Dict[str, float]]:
    sl_list: List[float] = []
    post_sl_pips_list: List[float] = []

    for t in trades:
        slp = _sl_pips(t)
        if slp is not None:
            sl_list.append(slp)
        cont = _post_sl_pips(t)
        if cont is not None:
            post_sl_pips_list.append(cont)

    base_sl = _safe_median(sl_list)
    if base_sl is None or base_sl <= 0:
        return None

    post_sl_pips_med = _safe_median(post_sl_pips_list) or 0.0

    raw_floor = max(base_sl, FLOOR_FRACTION * post_sl_pips_med)
    capped_floor = min(raw_floor, MAX_FLOOR_MULTIPLE * base_sl)

    # Kept for the UI. post_sl_R is a diagnostic ratio; sl_factor is the
    # actual widening factor applied.
    post_sl_R = (post_sl_pips_med / base_sl) if base_sl > 0 else 0.0
    sl_factor = (capped_floor / base_sl) if base_sl > 0 else 1.0

    return {
        "base_sl_pips": round(base_sl, 2),
        "post_sl_R": round(post_sl_R, 3),
        "post_sl_cont_pips_median": round(post_sl_pips_med, 2),
        "sl_factor": round(sl_factor, 3),
        "min_sl_pips": round(capped_floor, 2),
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

    out: Dict[str, Any] = {
        "formula_version": PIP_CALC_FORMULA_VERSION,
        "floor_fraction": FLOOR_FRACTION,
        "max_floor_multiple": MAX_FLOOR_MULTIPLE,
        "min_trades": MIN_TRADES,
        "pairs": {},
    }

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
    """
    Returns the payload only if it matches the current formula version.
    A stale v1.x payload is silently ignored (returns None), so a
    transition deploy will not apply the old unstable floors.
    """
    path = _config_path()
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception:
        return None
    if payload.get("formula_version") != PIP_CALC_FORMULA_VERSION:
        print(
            f"[pip_calculator] ignoring stale payload "
            f"(found {payload.get('formula_version')}, "
            f"expected {PIP_CALC_FORMULA_VERSION})",
            flush=True,
        )
        return None
    return payload


def min_sl_pips_for(
    payload: Optional[Dict[str, Any]],
    pair: str,
    strategy: str,
) -> Optional[float]:
    if not payload:
        return None
    if payload.get("formula_version") != PIP_CALC_FORMULA_VERSION:
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
    pip_calc_payload: Optional[Dict[str, Any]] = None,
) -> float:
    """
    Combined floor used by both the simulator and the live execution engine:

        max( GLOBAL_PARAMS.min_stop_pips[symbol], pip_calc.min_sl_pips )

    Returns 0.0 when neither source provides a value.
    """
    hardcoded = 0.0
    try:
        from core.session_config import GLOBAL_PARAMS
        hardcoded = float(
            (getattr(GLOBAL_PARAMS, "min_stop_pips", {}) or {})
            .get(symbol.upper(), 0.0) or 0.0
        )
    except Exception:
        hardcoded = 0.0

    data_driven = min_sl_pips_for(pip_calc_payload, symbol, strategy) or 0.0
    return max(hardcoded, data_driven)
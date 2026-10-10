"""
backtest/entry_analysis.py
Pool the trades from the "Adaptive · BE off · Trail off" report of every
pair that has a saved result and report which entry features separate
winners from losers. Adds alt-target R statistics and per-pair breakdown
for the starred buckets.

Writes: backtest/output/entry_analysis.json

PROPOSED: backtest-only. No effect on live trading.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from backtest.paths import OUTPUT_DIR
from backtest.features import FEATURE_NAMES


# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------
CONTINUOUS_FEATURES = {
    "ema200_dist_atr",
    "ema_spread_atr",
    "eff_ratio_30",
    "atr_pctile",
    "adr_used",
    "room_atr",
    "stop_atr",
    "spread_r",
}
DISCRETE_FEATURES = {
    "htf_d1",
    "htf_h4",
    "mins_since_open",
    "trade_of_day",
    # PROPOSED additions
    "session",
    "hour_sast",
    "weekday",
    "direction",
}
STRING_FEATURES = {
    # PROPOSED: read-only string sub-type label from the strategy signal.
    "setup_tag",
}

MIN_BUCKET_TRADES = 60
MIN_STRATEGY_TRADES = 100
STAR_PF_EDGE = 0.20
QUARTERS = 4
DEFAULT_WHITELIST = ["US30", "GOLD", "NAS100", "GERMAN30", "EURUSD", "GBPUSD", "USDJPY"]
RESULT_VALUES = ("WIN", "LOSS", "BREAKEVEN")

# PROPOSED: four alt-target keys and their multipliers.
ALT_KEYS = ("alt_r_1", "alt_r_15", "alt_r_2", "alt_r_3")
ALT_MULTIPLIERS = {"alt_r_1": 1.0, "alt_r_15": 1.5, "alt_r_2": 2.0, "alt_r_3": 3.0}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_float(v: Any) -> Optional[float]:
    try:
        f = float(v)
        return f if np.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _trade_time(t: Dict[str, Any]) -> Optional[datetime]:
    ts = t.get("signal_time_utc")
    if not ts:
        return None
    try:
        return datetime.strptime(str(ts), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _kpis(trades: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not trades:
        return {"trades": 0, "win_rate": 0.0, "avg_r": 0.0, "profit_factor": 0.0}
    n = len(trades)
    wins = [t for t in trades if t.get("result") == "WIN"]
    losses = [t for t in trades if t.get("result") == "LOSS"]
    gross_win = sum(float(t.get("money_pnl", 0.0) or 0.0) for t in wins)
    gross_loss = abs(sum(float(t.get("money_pnl", 0.0) or 0.0) for t in losses))
    pf = (gross_win / gross_loss) if gross_loss > 0 else (99.0 if gross_win > 0 else 0.0)
    avg_r = float(np.mean([float(t.get("r_multiple", 0.0) or 0.0) for t in trades]))
    wr = (len(wins) / n) * 100.0
    return {
        "trades": n,
        "win_rate": round(wr, 1),
        "avg_r": round(avg_r, 3),
        "profit_factor": round(pf, 2),
    }


def _pf_at_1r(trades: List[Dict[str, Any]]) -> float:
    """
    PROPOSED. Profit factor computed on the alt_r_1 values (in R). Wins are
    positive alt_r_1, losses are negative alt_r_1. Returns 0.0 when no
    usable alt_r_1 exists, and 99.0 when there are no losses but there is
    at least one win.
    """
    gains = 0.0
    losses = 0.0
    any_val = False
    for t in trades:
        v = _safe_float(t.get("alt_r_1"))
        if v is None:
            continue
        any_val = True
        if v > 0:
            gains += v
        elif v < 0:
            losses += abs(v)
    if not any_val:
        return 0.0
    if losses <= 0:
        return 99.0 if gains > 0 else 0.0
    return gains / losses


def _mean_alt_r(trades: List[Dict[str, Any]]) -> Dict[str, Optional[float]]:
    """PROPOSED. Mean alt-target R across a bucket. None when no data."""
    out: Dict[str, Optional[float]] = {}
    for key in ALT_KEYS:
        vals = [_safe_float(t.get(key)) for t in trades]
        vals = [v for v in vals if v is not None]
        out[key] = round(float(np.mean(vals)), 3) if vals else None
    return out


def _quarters_above_pf1(trades: List[Dict[str, Any]], quarter_edges: List[Tuple[datetime, datetime]]) -> int:
    """
    Number of the 4 date quarters where PF at 1R is strictly > 1.0.
    Quarters with fewer than 3 usable trades are skipped.
    """
    if not quarter_edges:
        return 0
    buckets: List[List[Dict[str, Any]]] = [[] for _ in quarter_edges]
    for t in trades:
        qi = _quarter_index(_trade_time(t), quarter_edges)
        if 0 <= qi < len(buckets):
            buckets[qi].append(t)
    count = 0
    for b in buckets:
        if len(b) < 3:
            continue
        if _pf_at_1r(b) > 1.0:
            count += 1
    return count


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def _load_pair_trades(symbol: str, output_dir: str) -> List[Dict[str, Any]]:
    """
    Return the trades from the Adaptive · BE off · Trail off report for a
    single pair. Empty list on any failure.
    """
    summary_path = os.path.join(output_dir, f"{symbol}_summary.json")
    if not os.path.exists(summary_path):
        return []
    try:
        with open(summary_path, "r", encoding="utf-8") as f:
            summary = json.load(f)
    except Exception:
        return []

    target_file: Optional[str] = None
    for c in summary.get("combinations", []) or []:
        if (
            c.get("mode") == "adaptive"
            and c.get("be") == "off"
            and c.get("trail") == "off"
        ):
            target_file = c.get("report_file")
            break
    if not target_file:
        return []

    report_path = os.path.join(output_dir, target_file)
    if not os.path.exists(report_path):
        return []
    try:
        with open(report_path, "r", encoding="utf-8") as f:
            report = json.load(f)
    except Exception:
        return []

    trades = report.get("all_trades", [])
    if not isinstance(trades, list):
        return []
    for t in trades:
        if isinstance(t, dict):
            t["_symbol"] = symbol
    return trades


# ---------------------------------------------------------------------------
# Bucketing
# ---------------------------------------------------------------------------

def _quartile_edges(values: List[float]) -> Optional[Tuple[float, float, float, float, float]]:
    arr = np.asarray(values, dtype=float)
    if arr.size < 4:
        return None
    q1, q2, q3 = np.percentile(arr, [25, 50, 75])
    return float(q1), float(q2), float(q3), float(arr.min()), float(arr.max())


def _quartile_bucket_index(value: Optional[float], edges: Tuple[float, float, float, float, float]) -> int:
    if value is None:
        return -1
    q1, q2, q3, _mn, _mx = edges
    if value < q1:
        return 0
    if value < q2:
        return 1
    if value < q3:
        return 2
    return 3


def _quartile_bucket_label(idx: int, edges: Tuple[float, float, float, float, float]) -> str:
    q1, q2, q3, mn, mx = edges
    if idx == 0:
        return f"Q1({mn:.3f}-{q1:.3f})"
    if idx == 1:
        return f"Q2({q1:.3f}-{q2:.3f})"
    if idx == 2:
        return f"Q3({q2:.3f}-{q3:.3f})"
    return f"Q4({q3:.3f}-{mx:.3f})"


# ---------------------------------------------------------------------------
# Quarters
# ---------------------------------------------------------------------------

def _quarter_edges(pooled: List[Dict[str, Any]]) -> List[Tuple[datetime, datetime]]:
    times = [t for t in (_trade_time(x) for x in pooled) if t is not None]
    if not times:
        return []
    t_min, t_max = min(times), max(times)
    if t_max <= t_min:
        return [(t_min, t_max)]
    span = (t_max - t_min).total_seconds()
    step = span / float(QUARTERS)
    out: List[Tuple[datetime, datetime]] = []
    for i in range(QUARTERS):
        a = t_min + timedelta(seconds=step * i)
        b = t_min + timedelta(seconds=step * (i + 1))
        out.append((a, b))
    return out


def _quarter_index(t: Optional[datetime], edges: List[Tuple[datetime, datetime]]) -> int:
    if t is None or not edges:
        return -1
    for i, (a, b) in enumerate(edges):
        if a <= t < b:
            return i
    if t >= edges[-1][1]:
        return len(edges) - 1
    return -1


# ---------------------------------------------------------------------------
# One group analysis
# ---------------------------------------------------------------------------

def _analyze_group(
    group_name: str,
    trades: List[Dict[str, Any]],
    quarter_edges: List[Tuple[datetime, datetime]],
    pooled_edges: Optional[Dict[str, Any]] = None,
) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, Any]], Dict[str, Any]]:
    """
    Returns (buckets, baseline, edge_map).
    When pooled_edges is provided, that mapping is used instead of recomputing
    per-group edges. This is how the per-pair breakdown reuses the pooled
    boundaries.
    """
    if not trades:
        return [], None, {}

    baseline_kpi = _kpis(trades)
    baseline_pf_1r = _pf_at_1r(trades)
    baseline = {
        "group": group_name,
        "trades": baseline_kpi["trades"],
        "win_rate": baseline_kpi["win_rate"],
        "profit_factor": baseline_kpi["profit_factor"],
        "profit_factor_1r": round(baseline_pf_1r, 2),
        "avg_r_1": round(float(np.mean([_safe_float(t.get("alt_r_1")) or 0.0 for t in trades])), 3) if trades else 0.0,
        "quarters_above_1": _quarters_above_pf1(trades, quarter_edges),
    }

    out: List[Dict[str, Any]] = []
    edge_map: Dict[str, Any] = {}

    for feature in FEATURE_NAMES:
        is_continuous = feature in CONTINUOUS_FEATURES
        is_string = feature in STRING_FEATURES

        if is_string:
            keys = sorted({str(t.get(feature, "none")) for t in trades})
            for key in keys:
                b_trades = [t for t in trades if str(t.get(feature, "none")) == key]
                if len(b_trades) < MIN_BUCKET_TRADES:
                    continue
                row = _bucket_row(group_name, feature, key, b_trades, quarter_edges, baseline_pf_1r)
                out.append(row)
            continue

        values: List[float] = []
        for t in trades:
            v = _safe_float(t.get(feature))
            if v is not None:
                values.append(v)
        if not values:
            continue

        if is_continuous:
            if pooled_edges is not None and feature in pooled_edges:
                edges = pooled_edges[feature]
            else:
                edges = _quartile_edges(values)
                if edges is not None:
                    edge_map[feature] = edges
            if edges is None:
                continue
            for bidx in range(4):
                b_trades = [
                    t for t in trades
                    if _quartile_bucket_index(_safe_float(t.get(feature)), edges) == bidx
                ]
                if len(b_trades) < MIN_BUCKET_TRADES:
                    continue
                label = _quartile_bucket_label(bidx, edges)
                row = _bucket_row(group_name, feature, label, b_trades, quarter_edges, baseline_pf_1r)
                out.append(row)
        else:
            unique = sorted({int(v) for v in values if np.isfinite(v)})
            for u in unique:
                b_trades = [t for t in trades if _safe_float(t.get(feature)) == float(u)]
                if len(b_trades) < MIN_BUCKET_TRADES:
                    continue
                row = _bucket_row(group_name, feature, f"={u}", b_trades, quarter_edges, baseline_pf_1r)
                out.append(row)

    return out, baseline, edge_map


def _bucket_row(
    group_name: str,
    feature: str,
    bucket_label: str,
    b_trades: List[Dict[str, Any]],
    quarter_edges: List[Tuple[datetime, datetime]],
    baseline_pf_1r: float,
) -> Dict[str, Any]:
    k = _kpis(b_trades)
    pf_1r = _pf_at_1r(b_trades)
    alt_means = _mean_alt_r(b_trades)
    q_above = _quarters_above_pf1(b_trades, quarter_edges)
    is_star = (
        pf_1r >= baseline_pf_1r + STAR_PF_EDGE
        and pf_1r > 1.0
        and q_above >= 3
    )
    return {
        "group": group_name,
        "feature": feature,
        "bucket": bucket_label,
        "trades": k["trades"],
        "win_rate": k["win_rate"],
        "avg_r": k["avg_r"],
        "profit_factor": k["profit_factor"],
        "profit_factor_1r": round(pf_1r, 2),
        "avg_r_1": alt_means.get("alt_r_1"),
        "avg_r_15": alt_means.get("alt_r_15"),
        "avg_r_2": alt_means.get("alt_r_2"),
        "avg_r_3": alt_means.get("alt_r_3"),
        "quarters_above_1": q_above,
        "is_star": bool(is_star),
    }


# ---------------------------------------------------------------------------
# Per-pair breakdown of starred buckets
# ---------------------------------------------------------------------------

def _per_pair_breakdown_of_stars(
    pooled: List[Dict[str, Any]],
    stars: List[Dict[str, Any]],
    pooled_edges: Dict[str, Any],
    quarter_edges: List[Tuple[datetime, datetime]],
) -> List[Dict[str, Any]]:
    """
    For each starred bucket, re-apply the same bucket definition to each
    pair's own trades, so the analyst can see whether the pattern holds on
    each pair.
    """
    out: List[Dict[str, Any]] = []
    if not stars:
        return out

    by_symbol: Dict[str, List[Dict[str, Any]]] = {}
    for t in pooled:
        sym = t.get("_symbol") or t.get("symbol") or "UNKNOWN"
        by_symbol.setdefault(sym, []).append(t)

    for star in stars:
        feature = star["feature"]
        label = star["bucket"]
        row: Dict[str, Any] = {
            "group": star["group"],
            "feature": feature,
            "bucket": label,
            "pooled": {
                "trades": star["trades"],
                "win_rate": star["win_rate"],
                "profit_factor_1r": star["profit_factor_1r"],
                "quarters_above_1": star["quarters_above_1"],
            },
            "per_pair": {},
        }

        for sym, s_trades in by_symbol.items():
            filtered = _select_bucket(s_trades, feature, label, pooled_edges)
            if not filtered:
                row["per_pair"][sym] = {"trades": 0}
                continue
            k = _kpis(filtered)
            pf_1r = _pf_at_1r(filtered)
            q_above = _quarters_above_pf1(filtered, quarter_edges)
            row["per_pair"][sym] = {
                "trades": k["trades"],
                "win_rate": k["win_rate"],
                "profit_factor_1r": round(pf_1r, 2),
                "quarters_above_1": q_above,
            }
        out.append(row)
    return out


def _select_bucket(
    trades: List[Dict[str, Any]],
    feature: str,
    label: str,
    pooled_edges: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Apply the same bucket definition to a subset of trades."""
    if feature in STRING_FEATURES:
        return [t for t in trades if str(t.get(feature, "none")) == label]
    if feature in CONTINUOUS_FEATURES:
        edges = pooled_edges.get(feature)
        if edges is None:
            return []
        # Parse bucket index from the label prefix Q1/Q2/Q3/Q4
        if label.startswith("Q1"):
            idx = 0
        elif label.startswith("Q2"):
            idx = 1
        elif label.startswith("Q3"):
            idx = 2
        elif label.startswith("Q4"):
            idx = 3
        else:
            return []
        return [
            t for t in trades
            if _quartile_bucket_index(_safe_float(t.get(feature)), edges) == idx
        ]
    # Discrete feature label format is "=N"
    if label.startswith("="):
        try:
            u = float(label[1:])
        except ValueError:
            return []
        return [t for t in trades if _safe_float(t.get(feature)) == u]
    return []


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def run_entry_analysis(
    output_dir: Optional[str] = None,
    whitelist: Optional[List[str]] = None,
) -> Dict[str, Any]:
    if output_dir is None:
        output_dir = OUTPUT_DIR
    if whitelist is None:
        whitelist = DEFAULT_WHITELIST

    pooled: List[Dict[str, Any]] = []
    per_strategy: Dict[str, List[Dict[str, Any]]] = {}

    for sym in whitelist:
        pair_trades = _load_pair_trades(sym, output_dir)
        for t in pair_trades:
            if not isinstance(t, dict):
                continue
            if t.get("result") not in RESULT_VALUES:
                continue
            pooled.append(t)
            s = str(t.get("strategy", "UNKNOWN"))
            per_strategy.setdefault(s, []).append(t)

    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    if not pooled:
        return {
            "generated_at": generated_at,
            "window_start": None,
            "window_end": None,
            "total_trades": 0,
            "baselines": [],
            "buckets": [],
            "star_pair_breakdown": [],
            "strategies_with_enough": [],
        }

    times = [t for t in (_trade_time(x) for x in pooled) if t is not None]
    w_start = min(times).strftime("%Y-%m-%d") if times else None
    w_end = max(times).strftime("%Y-%m-%d") if times else None
    q_edges = _quarter_edges(pooled)

    all_buckets: List[Dict[str, Any]] = []
    baselines: List[Dict[str, Any]] = []
    pooled_edges: Dict[str, Any] = {}

    # First pass: compute the pooled edges from the full pool.
    a_buckets, a_baseline, a_edges = _analyze_group("ALL", pooled, q_edges)
    all_buckets.extend(a_buckets)
    if a_baseline:
        baselines.append(a_baseline)
    pooled_edges.update(a_edges)

    # Per-strategy with at least MIN_STRATEGY_TRADES trades. These use the
    # same pooled edges so buckets are comparable across groups.
    enough: List[str] = []
    for s, ts in per_strategy.items():
        if len(ts) < MIN_STRATEGY_TRADES:
            continue
        enough.append(s)
        s_buckets, s_baseline, _ = _analyze_group(s, ts, q_edges, pooled_edges=pooled_edges)
        all_buckets.extend(s_buckets)
        if s_baseline:
            baselines.append(s_baseline)

    # Sort: stars first, then highest PF@1R, then highest n.
    all_buckets.sort(
        key=lambda b: (
            0 if b.get("is_star") else 1,
            -float(b.get("profit_factor_1r") or 0.0),
            -int(b.get("trades") or 0),
        )
    )

    stars = [b for b in all_buckets if b.get("is_star")]
    star_pairs = _per_pair_breakdown_of_stars(pooled, stars, pooled_edges, q_edges)

    return {
        "generated_at": generated_at,
        "window_start": w_start,
        "window_end": w_end,
        "total_trades": len(pooled),
        "baselines": baselines,
        "buckets": all_buckets,
        "star_pair_breakdown": star_pairs,
        "strategies_with_enough": enough,
    }


def write_entry_analysis(output_dir: Optional[str] = None) -> bool:
    """
    Write entry_analysis.json to output_dir. Returns True on success.
    Never raises.
    """
    try:
        if output_dir is None:
            output_dir = OUTPUT_DIR
        os.makedirs(output_dir, exist_ok=True)
        payload = run_entry_analysis(output_dir=output_dir)
        out_path = os.path.join(output_dir, "entry_analysis.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"), allow_nan=False)
        print(
            f"[entry_analysis] wrote {out_path} "
            f"({len(payload.get('buckets', []))} buckets, "
            f"{len(payload.get('star_pair_breakdown', []))} star breakdowns, "
            f"{payload.get('total_trades', 0)} trades pooled)",
            flush=True,
        )
        return True
    except Exception as e:
        print(f"[entry_analysis] failed: {e}", flush=True)
        return False
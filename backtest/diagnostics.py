"""
backtest/diagnostics.py
Blueprint Phase-1 Deep Analytics Module.

Purely additive. Reads a finished trades array plus the M5 price series and
returns diagnostic payloads. Zero changes to the simulator, live bot, or
strategy engine.

Blueprint coverage:
  Section 4 item 19 - 24-hour hourly expectancy matrix
  Section 4 item 20 - day-of-week profiling (also surfaced by runner)
  Section 4 item 21 - session-rollover friction
  Section 6 item 26 - ATR volatility tiering
  Section 7 item 31 - consecutive loss streak and recovery metrics
  Section 7 item 32 - circuit-breaker simulation (risk halving)
  Section 7 item 36 - outlier dependency removal (top 5 percent dropped)
  Section 7 item 37 - Monte Carlo resampling (1000 shuffles)
  Section 7 item 38 - buy-and-hold benchmark (alpha)
"""

import numpy as np
import pandas as pd
from typing import List, Dict, Any

DIAGNOSTICS_VERSION = "1.0"

# Session-transition windows expressed in SAST (hour, minute) pairs.
# A trade is "in transition" if its entry falls in any of these bands.
SESSION_ROLLOVER_WINDOWS = [
    ("London Open",    7, 45,  8, 15),   # 08:00 London open +/- 15 min
    ("NY Open",       15, 15, 15, 45),   # 15:30 SAST open +/- 15 min
    ("Daily Rollover",20, 45, 21, 15),   # 21:00 SAST cTrader daily rollover +/- 15 min
]


def _kpis(trades: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Compact KPI bundle used by every sub-diagnostic."""
    if not trades:
        return {
            "count": 0,
            "win_rate": 0.0,
            "expectancy": 0.0,
            "profit_factor": 0.0,
            "net_pnl": 0.0,
        }

    wins = [t for t in trades if t.get("result") == "WIN"]
    losses = [t for t in trades if t.get("result") == "LOSS"]

    gross_win = sum(float(t.get("money_pnl", 0.0)) for t in wins)
    gross_loss = abs(sum(float(t.get("money_pnl", 0.0)) for t in losses))
    net = sum(float(t.get("money_pnl", 0.0)) for t in trades)
    wr = (len(wins) / len(trades)) * 100.0

    if gross_loss > 0:
        pf = gross_win / gross_loss
    else:
        pf = 99.0 if gross_win > 0 else 0.0

    wins_r = [float(t.get("r_multiple", 0.0)) for t in wins]
    losses_r = [abs(float(t.get("r_multiple", 0.0))) for t in losses]
    avg_w = sum(wins_r) / len(wins_r) if wins_r else 0.0
    avg_l = sum(losses_r) / len(losses_r) if losses_r else 0.0
    exp = (wr / 100.0) * avg_w - (1 - wr / 100.0) * avg_l

    return {
        "count": len(trades),
        "win_rate": round(wr, 1),
        "expectancy": round(float(exp), 3),
        "profit_factor": round(float(pf), 2),
        "net_pnl": round(float(net), 2),
    }


def _hourly_matrix(trades: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Section 4 item 19 - 24-hour expectancy matrix keyed by SAST hour."""
    hourly: Dict[int, List[Dict[str, Any]]] = {}
    for t in trades:
        ts = t.get("signal_time_sast")
        if not ts:
            continue
        try:
            hr = pd.to_datetime(ts).hour
        except Exception:
            continue
        hourly.setdefault(int(hr), []).append(t)

    return {str(h): _kpis(v) for h, v in sorted(hourly.items())}


def _session_rollover(trades: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Section 4 item 21 - inside vs outside session-transition windows."""
    in_window: List[Dict[str, Any]] = []
    out_window: List[Dict[str, Any]] = []

    for t in trades:
        ts = t.get("signal_time_sast")
        if not ts:
            out_window.append(t)
            continue
        try:
            dt = pd.to_datetime(ts)
        except Exception:
            out_window.append(t)
            continue

        cur_min = dt.hour * 60 + dt.minute
        in_any = False
        for _, h1, m1, h2, m2 in SESSION_ROLLOVER_WINDOWS:
            if (h1 * 60 + m1) <= cur_min <= (h2 * 60 + m2):
                in_any = True
                break
        (in_window if in_any else out_window).append(t)

    return {
        "in_transition": _kpis(in_window),
        "out_of_transition": _kpis(out_window),
    }


def _atr_tier(trades: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Section 6 item 26 - KPIs per volatility regime tier at entry."""
    tiers: Dict[str, List[Dict[str, Any]]] = {
        "LOW": [], "NORMAL": [], "HIGH": [], "UNKNOWN": []
    }
    for t in trades:
        regime = str(t.get("regime", "UNKNOWN") or "UNKNOWN").upper()
        if regime not in tiers:
            regime = "UNKNOWN"
        tiers[regime].append(t)

    return {k: _kpis(v) for k, v in tiers.items()}


def _streak_analysis(trades: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Section 7 item 31 - consecutive loss streaks and peak-DD recovery."""
    ordered = sorted(trades, key=lambda t: t.get("signal_time_utc", ""))

    streaks: List[int] = []
    cur = 0
    for t in ordered:
        if t.get("result") == "LOSS":
            cur += 1
        else:
            if cur > 0:
                streaks.append(cur)
            cur = 0
    if cur > 0:
        streaks.append(cur)

    pnls = np.array([float(t.get("money_pnl", 0.0)) for t in ordered], dtype=float)
    if pnls.size == 0:
        return {
            "max_consecutive_losses": 0,
            "average_streak": 0.0,
            "streak_count": 0,
            "recovery_trades_from_peak_dd": 0,
            "peak_drawdown": 0.0,
        }

    cum = np.cumsum(pnls)
    peak = np.maximum.accumulate(cum)
    dd = peak - cum
    trough_idx = int(np.argmax(dd)) if dd.size else 0
    peak_dd = float(dd[trough_idx]) if dd.size else 0.0

    recovery = 0
    if trough_idx < len(cum) - 1:
        target = peak[trough_idx]
        for i in range(trough_idx + 1, len(cum)):
            recovery += 1
            if cum[i] >= target:
                break

    return {
        "max_consecutive_losses": max(streaks) if streaks else 0,
        "average_streak": round(sum(streaks) / len(streaks), 2) if streaks else 0.0,
        "streak_count": len(streaks),
        "recovery_trades_from_peak_dd": recovery,
        "peak_drawdown": round(peak_dd, 2),
    }


def _circuit_breaker_sim(
    trades: List[Dict[str, Any]],
    threshold: int = 3,
    risk_mult: float = 0.5,
) -> Dict[str, Any]:
    """Section 7 item 32 - what if risk is halved after every Nth consecutive loss?"""
    ordered = sorted(trades, key=lambda t: t.get("signal_time_utc", ""))
    if not ordered:
        return {
            "original_net_pnl": 0.0,
            "simulated_net_pnl": 0.0,
            "trades_halved": 0,
            "protection_delta": 0.0,
        }

    orig_net = 0.0
    sim_net = 0.0
    streak = 0
    halving = False
    halved = 0

    for t in ordered:
        pnl = float(t.get("money_pnl", 0.0))
        orig_net += pnl
        if halving:
            sim_net += pnl * risk_mult
            halved += 1
        else:
            sim_net += pnl

        if t.get("result") == "LOSS":
            streak += 1
            if streak >= threshold:
                halving = True
        else:
            streak = 0
            halving = False

    return {
        "original_net_pnl": round(orig_net, 2),
        "simulated_net_pnl": round(sim_net, 2),
        "trades_halved": halved,
        "protection_delta": round(sim_net - orig_net, 2),
    }


def _outlier_removal(trades: List[Dict[str, Any]], pct: float = 0.05) -> Dict[str, Any]:
    """Section 7 item 36 - drop top N percent best trades and recompute."""
    if not trades:
        empty = _kpis([])
        return {
            "full": empty,
            "trimmed": empty,
            "outlier_count": 0,
            "impact_pct": 0.0,
        }

    sorted_by_pnl = sorted(
        trades, key=lambda t: float(t.get("money_pnl", 0.0)), reverse=True
    )
    n_drop = max(1, int(len(sorted_by_pnl) * pct))
    trimmed = sorted_by_pnl[n_drop:]

    full_k = _kpis(trades)
    trimmed_k = _kpis(trimmed)
    full_net = full_k["net_pnl"]
    trimmed_net = trimmed_k["net_pnl"]

    impact = ((full_net - trimmed_net) / abs(full_net)) * 100.0 if full_net != 0 else 0.0

    return {
        "full": full_k,
        "trimmed": trimmed_k,
        "outlier_count": n_drop,
        "impact_pct": round(impact, 1),
    }


def _monte_carlo(
    trades: List[Dict[str, Any]],
    iterations: int = 1000,
    starting_equity: float = 1000.0,
) -> Dict[str, Any]:
    """Section 7 item 37 - shuffle trade sequence N times, build DD distribution."""
    pnls = [float(t.get("money_pnl", 0.0)) for t in trades]
    if len(pnls) < 5:
        return {
            "iterations": 0,
            "median_max_dd": 0.0,
            "p5_max_dd": 0.0,
            "p95_max_dd": 0.0,
            "median_final_equity": starting_equity,
            "prob_positive": 0.0,
        }

    rng = np.random.default_rng(42)
    arr = np.array(pnls, dtype=float)
    max_dds = np.empty(iterations)
    finals = np.empty(iterations)

    for i in range(iterations):
        shuffled = rng.permutation(arr)
        eq = starting_equity + np.cumsum(shuffled)
        peaks = np.maximum.accumulate(np.concatenate([[starting_equity], eq]))
        dd = peaks[1:] - eq
        max_dds[i] = float(dd.max()) if dd.size else 0.0
        finals[i] = float(eq[-1])

    return {
        "iterations": iterations,
        "median_max_dd": round(float(np.median(max_dds)), 2),
        "p5_max_dd": round(float(np.percentile(max_dds, 5)), 2),
        "p95_max_dd": round(float(np.percentile(max_dds, 95)), 2),
        "median_final_equity": round(float(np.median(finals)), 2),
        "prob_positive": round(float((finals > starting_equity).mean() * 100.0), 1),
    }


def _buy_and_hold(
    m5_df: pd.DataFrame,
    sim_start_idx: int,
    starting_equity: float,
    strategy_net_pnl: float,
) -> Dict[str, Any]:
    """Section 7 item 38 - passive hold benchmark plus alpha."""
    try:
        first_close = float(m5_df.iloc[sim_start_idx]["close"])
        last_close = float(m5_df.iloc[-1]["close"])
    except (IndexError, KeyError, TypeError):
        first_close = last_close = 0.0

    if first_close <= 0 or last_close <= 0:
        return {
            "first_close": 0.0,
            "last_close": 0.0,
            "bh_return_pct": 0.0,
            "bh_net_pnl": 0.0,
            "strategy_net_pnl": round(strategy_net_pnl, 2),
            "alpha": 0.0,
            "verdict": "INSUFFICIENT_DATA",
        }

    bh_return_pct = ((last_close - first_close) / first_close) * 100.0
    bh_net_pnl = starting_equity * (bh_return_pct / 100.0)
    alpha = strategy_net_pnl - bh_net_pnl

    if alpha > 0 and strategy_net_pnl > 0:
        verdict = "STRATEGY_BEATS_HOLD"
    elif bh_net_pnl > 0 and strategy_net_pnl <= 0:
        verdict = "HOLD_BEATS_STRATEGY"
    elif strategy_net_pnl > 0:
        verdict = "STRATEGY_PROFITABLE_HOLD_LOSS"
    else:
        verdict = "BOTH_NEGATIVE"

    return {
        "first_close": round(first_close, 5),
        "last_close": round(last_close, 5),
        "bh_return_pct": round(bh_return_pct, 2),
        "bh_net_pnl": round(bh_net_pnl, 2),
        "strategy_net_pnl": round(strategy_net_pnl, 2),
        "alpha": round(alpha, 2),
        "verdict": verdict,
    }


def compute_diagnostics(
    trades: List[Dict[str, Any]],
    m5_df: pd.DataFrame,
    sim_start_idx: int,
    starting_equity: float = 1000.0,
) -> Dict[str, Any]:
    """
    Master entry point. Safe to call on any trade list (including empty).
    Returns a JSON-safe dict consumed by the frontend Diagnostics tab.
    """
    valid = [
        t for t in trades
        if isinstance(t, dict) and t.get("result") in ("WIN", "LOSS", "BREAKEVEN")
    ]

    if not valid:
        empty_kpi = _kpis([])
        return {
            "version": DIAGNOSTICS_VERSION,
            "hour_kpis": {},
            "session_rollover": {
                "in_transition": empty_kpi,
                "out_of_transition": empty_kpi,
            },
            "atr_tier_kpis": {
                "LOW": empty_kpi, "NORMAL": empty_kpi,
                "HIGH": empty_kpi, "UNKNOWN": empty_kpi,
            },
            "streak_analysis": {
                "max_consecutive_losses": 0,
                "average_streak": 0.0,
                "streak_count": 0,
                "recovery_trades_from_peak_dd": 0,
                "peak_drawdown": 0.0,
            },
            "circuit_breaker_sim": {
                "original_net_pnl": 0.0,
                "simulated_net_pnl": 0.0,
                "trades_halved": 0,
                "protection_delta": 0.0,
            },
            "outlier_removal": {
                "full": empty_kpi,
                "trimmed": empty_kpi,
                "outlier_count": 0,
                "impact_pct": 0.0,
            },
            "monte_carlo": {
                "iterations": 0,
                "median_max_dd": 0.0,
                "p5_max_dd": 0.0,
                "p95_max_dd": 0.0,
                "median_final_equity": starting_equity,
                "prob_positive": 0.0,
            },
            "buy_and_hold": {
                "first_close": 0.0,
                "last_close": 0.0,
                "bh_return_pct": 0.0,
                "bh_net_pnl": 0.0,
                "strategy_net_pnl": 0.0,
                "alpha": 0.0,
                "verdict": "INSUFFICIENT_DATA",
            },
        }

    full_kpis = _kpis(valid)
    strategy_net = full_kpis["net_pnl"]

    return {
        "version": DIAGNOSTICS_VERSION,
        "hour_kpis": _hourly_matrix(valid),
        "session_rollover": _session_rollover(valid),
        "atr_tier_kpis": _atr_tier(valid),
        "streak_analysis": _streak_analysis(valid),
        "circuit_breaker_sim": _circuit_breaker_sim(valid),
        "outlier_removal": _outlier_removal(valid),
        "monte_carlo": _monte_carlo(valid, starting_equity=starting_equity),
        "buy_and_hold": _buy_and_hold(
            m5_df, sim_start_idx, starting_equity, strategy_net
        ),
    }
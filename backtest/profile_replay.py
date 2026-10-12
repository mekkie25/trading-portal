"""
backtest/profile_replay.py
Post-hoc replay of a completed trade list across all risk profiles and
a set of starting balances, at zero additional backtest time.

Why this works: profiles only change position sizing, not entries.
The trade list captures WHO traded, WHEN, and WHAT R they got. To
replay under a different profile, we just re-run the arithmetic:

    equity = starting_balance
    for each trade in chronological order:
        risk_pct  = profile_lookup(equity, currency)
        risk_cash = equity * risk_pct / 100
        if min_lot_cash_risk_for_this_trade > tolerance * risk_cash:
            skip   # min-lot filter would have rejected this trade
        else:
            equity += r_multiple * risk_cash

The min-lot cash risk per trade is stored on each trade at entry, so
the replay does not need price action, candles, or FX conversion.
It is exact, not an approximation.
"""

from typing import Any, Dict, List, Optional


# Mirror of RISK_PROFILES in risk/risk_manager.py.
# The backtester never imports the live RiskManager to avoid coupling.
PROFILE_BANDS_ZAR = [500.0, 2000.0, 10000.0, 50000.0]

PROFILES: Dict[str, Dict[str, Any]] = {
    "None":        None,
    "Steady":      {"risk_pct_by_band": [5.0, 3.0, 2.0, 1.5, 1.0]},
    "Balanced":    {"risk_pct_by_band": [10.0, 6.0, 4.0, 3.0, 2.0]},
    "Aggressive":  {"risk_pct_by_band": [30.0, 15.0, 8.0, 5.0, 3.0]},
    "Max Growth":  {"risk_pct_by_band": [35.0, 25.0, 12.0, 6.0, 4.0]},
}


def _usd_to_zar_factor() -> float:
    """
    Static fallback used only when a USDZAR series is not supplied.
    The real conversion happens in the loader if USDZAR candles exist.
    """
    return 18.0


def _band_risk_pct(profile_name: str, equity_zar: float) -> float:
    bands = PROFILE_BANDS_ZAR
    risks = PROFILES[profile_name]["risk_pct_by_band"]
    if equity_zar < bands[0]:
        return risks[0]
    if equity_zar < bands[1]:
        return risks[1]
    if equity_zar < bands[2]:
        return risks[2]
    if equity_zar < bands[3]:
        return risks[3]
    return risks[4]


def replay_one(
    trades: List[Dict[str, Any]],
    starting_balance: float,
    profile_name: str,
    flat_risk_pct: float = 1.0,
    zar_per_usd: float = 18.0,
    min_lot_tolerance: float = 1.5,
) -> Dict[str, Any]:
    """
    trades: list of trade dicts, in chronological order.
    Each trade must have:
      r_multiple : float
      min_lot_cash_risk_usd : float  (dollar cost of a min-lot stop)
    """
    equity = float(starting_balance)
    peak = equity
    max_dd = 0.0
    taken = 0
    skipped_min_lot = 0
    wins = 0
    losses = 0
    curve: List[Dict[str, Any]] = []

    for t in trades:
        try:
            r = float(t.get("r_multiple", 0.0) or 0.0)
            min_lot_cash = float(t.get("min_lot_cash_risk_usd", 0.0) or 0.0)
        except (TypeError, ValueError):
            continue

        if profile_name == "None":
            risk_pct = float(flat_risk_pct)
        else:
            equity_zar = equity * zar_per_usd
            risk_pct = _band_risk_pct(profile_name, equity_zar)

        risk_cash = equity * (risk_pct / 100.0)

        if min_lot_cash > 0 and min_lot_cash > (min_lot_tolerance * risk_cash):
            skipped_min_lot += 1
            continue

        equity += r * risk_cash
        taken += 1
        if r > 0.1:
            wins += 1
        elif r < -0.1:
            losses += 1

        if equity > peak:
            peak = equity
        dd = peak - equity
        if dd > max_dd:
            max_dd = dd

        curve.append({"i": taken, "equity": round(equity, 2)})

    return {
        "profile": profile_name,
        "starting_balance": round(starting_balance, 2),
        "final_equity": round(equity, 2),
        "net_pnl": round(equity - starting_balance, 2),
        "net_pnl_pct": round(((equity - starting_balance) / starting_balance) * 100.0, 2) if starting_balance > 0 else 0.0,
        "max_dd": round(max_dd, 2),
        "trades_taken": taken,
        "trades_skipped_min_lot": skipped_min_lot,
        "wins": wins,
        "losses": losses,
        "win_rate": round((wins / taken) * 100.0, 1) if taken > 0 else 0.0,
        "curve": curve[-500:],  # cap curve length for the panel
    }


def replay_matrix(
    trades: List[Dict[str, Any]],
    starting_balances: Optional[List[float]] = None,
    zar_per_usd: float = 18.0,
) -> Dict[str, Any]:
    """
    Returns {balances: [...], profiles: {name: {balance: replay_result}}}.
    trades must already be in chronological order.
    """
    if starting_balances is None:
        starting_balances = [10.0, 50.0, 100.0, 500.0, 1000.0]

    out: Dict[str, Any] = {"balances": starting_balances, "profiles": {}}
    for pname in PROFILES.keys():
        per_balance: Dict[str, Any] = {}
        for bal in starting_balances:
            per_balance[str(bal)] = replay_one(
                trades, bal, pname, zar_per_usd=zar_per_usd,
            )
        out["profiles"][pname] = per_balance
    return out
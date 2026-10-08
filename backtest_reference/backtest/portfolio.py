"""
backtest/portfolio.py
Section 7 item 30 - Concurrent pair correlation analysis.

Reads the best-combo report for each whitelisted pair (highest profit
factor with >= 30 trades, or the report with most trades as fallback),
builds a daily P&L matrix, and computes:
  - pairwise correlation matrix
  - portfolio drawdown when all pairs trade concurrently
  - sum of individual per-pair drawdowns
  - diversification ratio (sum_ind_dd / portfolio_dd)

Zero simulator changes. Zero live-bot impact. Safe to call anytime.
"""

import os
import json
import glob
import numpy as np
import pandas as pd
from typing import Dict, Any, List

DEFAULT_WHITELIST = ["US30", "GOLD", "NAS100", "GERMAN30", "EURUSD", "GBPUSD", "USDJPY"]


def _load_best_trades_for_pair(symbol: str, output_dir: str) -> List[Dict[str, Any]]:
    """Best combo = highest profit factor with >= 30 trades. Fallback = most trades."""
    pattern = os.path.join(output_dir, f"{symbol}_*_be*_trail*_report.json")
    files = glob.glob(pattern)
    if not files:
        return []

    best_pf = -1.0
    best_trades: List[Dict[str, Any]] = []

    for fpath in files:
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                data = json.load(f)
            kpis = data.get("global_kpis", {})
            if (kpis.get("count", 0) >= 30) and (kpis.get("profit_factor", 0.0) > best_pf):
                best_pf = kpis.get("profit_factor", 0.0)
                best_trades = data.get("all_trades", [])
        except Exception:
            continue

    if not best_trades and files:
        best_count = -1
        for fpath in files:
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                trades = data.get("all_trades", [])
                if len(trades) > best_count:
                    best_count = len(trades)
                    best_trades = trades
            except Exception:
                continue
    return best_trades


def compute_portfolio_correlation(
    output_dir: str,
    whitelist: List[str] = None,
) -> Dict[str, Any]:
    """Master entry. Returns a JSON-safe correlation + drawdown payload."""
    if whitelist is None:
        whitelist = DEFAULT_WHITELIST

    symbol_daily: Dict[str, Dict[str, float]] = {}
    symbol_trade_count: Dict[str, int] = {}
    all_days = set()

    for sym in whitelist:
        trades = _load_best_trades_for_pair(sym, output_dir)
        symbol_trade_count[sym] = len(trades)
        daily: Dict[str, float] = {}
        for t in trades:
            day = str(t.get("date_sast") or t.get("date") or "")
            if not day:
                continue
            daily[day] = daily.get(day, 0.0) + float(t.get("money_pnl", 0.0))
            all_days.add(day)
        symbol_daily[sym] = daily

    all_days_sorted = sorted(all_days)
    if not all_days_sorted:
        return {
            "symbols": whitelist,
            "trade_counts": symbol_trade_count,
            "correlation_matrix": {},
            "portfolio_drawdown": 0.0,
            "sum_of_individual_drawdowns": 0.0,
            "diversification_ratio": 0.0,
            "days": 0,
            "avg_daily_correlation": 0.0,
        }

    df_data = {}
    for sym, daily in symbol_daily.items():
        df_data[sym] = [daily.get(d, 0.0) for d in all_days_sorted]
    df = pd.DataFrame(df_data, index=all_days_sorted)

    corr = df.corr().fillna(0.0)
    corr_dict = {col: {row: round(float(corr.loc[row, col]), 3) for row in corr.index} for col in corr.columns}

    portfolio_daily = df.sum(axis=1)
    portfolio_equity = portfolio_daily.cumsum()
    peak = portfolio_equity.cummax()
    dd = peak - portfolio_equity
    portfolio_dd = float(dd.max()) if not dd.empty else 0.0

    sum_ind_dd = 0.0
    for sym in df.columns:
        eq = df[sym].cumsum()
        pk = eq.cummax()
        d = pk - eq
        sum_ind_dd += float(d.max()) if not d.empty else 0.0

    div_ratio = (sum_ind_dd / portfolio_dd) if portfolio_dd > 0 else 0.0

    if len(corr) > 1:
        upper = corr.values[np.triu_indices_from(corr.values, k=1)]
        avg_corr = float(np.nanmean(upper)) if upper.size > 0 else 0.0
    else:
        avg_corr = 0.0

    return {
        "symbols": list(df.columns),
        "trade_counts": symbol_trade_count,
        "correlation_matrix": corr_dict,
        "portfolio_drawdown": round(portfolio_dd, 2),
        "sum_of_individual_drawdowns": round(sum_ind_dd, 2),
        "diversification_ratio": round(div_ratio, 2),
        "days": len(all_days_sorted),
        "avg_daily_correlation": round(avg_corr, 3),
    }
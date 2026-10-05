"""
backtest/export_advice.py
Rule-based suggestion and advisory engine for backtest export.
Produces plain-English, ranked actionable improvement tips with estimated dollar impact.
Requires at least 30 trades for any rule to trigger. No external AI dependencies.
"""

from typing import Dict, List, Any


def generate_pair_advice(pair_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Evaluates rule-based advice for a single asset based on its summary
    and best combination metrics.
    """
    suggestions = []
    combos = pair_data.get("combinations", [])
    best = pair_data.get("best_combination", {})
    if not best:
        return suggestions

    total_trades = best.get("total_trades", 0)
    if total_trades < 30:
        return [{
            "text": f"{pair_data.get('symbol', 'Asset')}: Insufficient trade sample ({total_trades} trades). Minimum 30 trades required before tuning.",
            "impact": 0.0,
            "type": "SAMPLE_SIZE"
        }]

    pf = best.get("profit_factor", 1.0)
    net_pnl = best.get("net_pnl", 0.0)
    symbol = pair_data.get("symbol", "")

    # 1. Negative strategy with net loss: disable or retune
    strat_kpis = best.get("strategy_kpis", {})
    for s_name, s_data in strat_kpis.items():
        s_count = s_data.get("count", 0)
        s_pf = s_data.get("profit_factor", 1.0)
        s_net = s_data.get("net_pnl", 0.0)
        if s_count >= 15 and s_pf < 1.0 and s_net < 0:
            suggestions.append({
                "text": f"Disable or retune {s_name} on {symbol}: produced PF {s_pf:.2f} with a net loss of -${abs(s_net):.2f}.",
                "impact": abs(s_net),
                "type": "STRATEGY_RETUNE"
            })
        elif s_count >= 20 and s_pf >= 1.3 and s_net > 0:
            suggestions.append({
                "text": f"Maintain {s_name} on {symbol} as core edge: strong PF {s_pf:.2f} netting +${s_net:.2f}. Consider scaling position size.",
                "impact": s_net * 0.5,
                "type": "STRATEGY_EXPAND"
            })

    # 2. Unfavorable day-of-week
    dow_kpis = best.get("dow_kpis", {})
    for dow, d_data in dow_kpis.items():
        d_count = d_data.get("count", 0)
        d_exp = d_data.get("expectancy", 0.0)
        d_net = d_data.get("net_pnl", 0.0)
        if d_count >= 10 and (d_exp < 0 or d_net < 0):
            suggestions.append({
                "text": f"Avoid entries on {dow}s for {symbol}: negative expectancy ({d_exp:.2f}R) producing -${abs(d_net):.2f}.",
                "impact": abs(d_net),
                "type": "DAY_FILTER"
            })

    # 3. Adaptive vs Legacy comparison
    adaptive_combos = [c for c in combos if c.get("mode") == "adaptive" and c.get("total_trades", 0) >= 30]
    legacy_combos = [c for c in combos if c.get("mode") == "legacy" and c.get("total_trades", 0) >= 30]
    if adaptive_combos and legacy_combos:
        best_adp_pf = max(c.get("profit_factor", 0.0) for c in adaptive_combos)
        best_leg_pf = max(c.get("profit_factor", 0.0) for c in legacy_combos)
        best_adp_net = max(c.get("net_pnl", 0.0) for c in adaptive_combos)
        best_leg_net = max(c.get("net_pnl", 0.0) for c in legacy_combos)

        gap = best_adp_pf - best_leg_pf
        if abs(gap) >= 0.20:
            if gap > 0:
                suggestions.append({
                    "text": f"Prefer Adaptive Mode over Legacy for {symbol} (PF {best_adp_pf:.2f} vs {best_leg_pf:.2f}, advantage +${best_adp_net - best_leg_net:.2f}).",
                    "impact": max(0.0, best_adp_net - best_leg_net),
                    "type": "MODE_SELECTION"
                })
            else:
                suggestions.append({
                    "text": f"Prefer Legacy Mode over Adaptive for {symbol} (PF {best_leg_pf:.2f} vs {best_adp_pf:.2f}, advantage +${best_leg_net - best_adp_net:.2f}).",
                    "impact": max(0.0, best_leg_net - best_adp_net),
                    "type": "MODE_SELECTION"
                })

    # 4. Breakeven and Trailing stop recommendation
    be_off_pfs = [c.get("profit_factor", 0) for c in combos if c.get("be") == "off" and c.get("total_trades", 0) >= 30]
    be_on_pfs = [c.get("profit_factor", 0) for c in combos if c.get("be") == "on" and c.get("total_trades", 0) >= 30]
    if be_off_pfs and be_on_pfs:
        avg_off = sum(be_off_pfs) / len(be_off_pfs)
        avg_on = sum(be_on_pfs) / len(be_on_pfs)
        if abs(avg_off - avg_on) >= 0.15:
            rec = "BE Off" if avg_off > avg_on else "BE On"
            suggestions.append({
                "text": f"Recommend {rec} for {symbol}: delivers higher average profit factor ({max(avg_off, avg_on):.2f} vs {min(avg_off, avg_on):.2f}).",
                "impact": 50.0,
                "type": "BE_TUNING"
            })

    # 5. Skip reasons > 30%
    skip_summary = best.get("skipped_summary", {})
    total_skips = sum(skip_summary.values()) if isinstance(skip_summary, dict) else 0
    if total_skips >= 20:
        for reason, count in skip_summary.items():
            if (count / total_skips) >= 0.30:
                suggestions.append({
                    "text": f"Evaluate relaxing '{reason}' on {symbol}: accounts for {count} of {total_skips} skipped setups ({(count/total_skips)*100:.0f}%).",
                    "impact": 40.0,
                    "type": "SKIP_TUNING"
                })

    # 6. Adaptive coverage below 90%
    adp_cov = best.get("adaptive_effective_pct", 100.0)
    if adp_cov < 90.0:
        suggestions.append({
            "text": f"Extend historical candle store for {symbol}: Adaptive volatility was active on only {adp_cov:.1f}% of bars (needs 120 D1 bars warmup).",
            "impact": 20.0,
            "type": "DATA_WARMUP"
        })

    # 7. Unviable pair across all 8 combinations
    all_combos_valid = [c for c in combos if c.get("total_trades", 0) >= 25]
    if all_combos_valid and all(c.get("profit_factor", 0) < 1.0 for c in all_combos_valid):
        all_losses = sum(abs(c.get("net_pnl", 0)) for c in all_combos_valid if c.get("net_pnl", 0) < 0)
        suggestions.append({
            "text": f"Discontinue live trading on {symbol}: produced negative profit factor across all 8 tested combinations.",
            "impact": all_losses / len(all_combos_valid),
            "type": "PAIR_VIABILITY"
        })

    # Sort descending by estimated dollar impact
    suggestions.sort(key=lambda s: s.get("impact", 0.0), reverse=True)
    return suggestions
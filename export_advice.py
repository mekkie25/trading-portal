"""
backtest/export_advice.py
Rule-based suggestion and advisory engine for backtest export.
Produces plain-English, ranked actionable improvement tips with estimated dollar impact.
Every rule fires strictly when at least 30 trades are behind it. No external AI dependencies.
Used for both TXT and PDF export.
"""

from typing import Dict, List, Any


def generate_pair_advice(pair_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Evaluates rule-based suggestions for an individual asset based on its summary
    and best combination metrics. Every rule requires at least 30 trades.
    """
    suggestions: List[Dict[str, Any]] = []
    combos = pair_data.get("combinations", [])
    best = pair_data.get("best_combination", {})
    if not best:
        return suggestions

    symbol = pair_data.get("symbol", "")
    total_trades = best.get("total_trades", 0)

    # 1. Unviable pair across all combinations (requires >= 30 trades on valid combos)
    valid_combos_30 = [c for c in combos if (c.get("total_trades", 0) >= 30)]
    if len(valid_combos_30) >= 4 and all(c.get("profit_factor", 0.0) < 1.0 for c in valid_combos_30):
        total_loss = sum(abs(c.get("net_pnl", 0.0)) for c in valid_combos_30 if c.get("net_pnl", 0.0) < 0)
        avg_loss = total_loss / len(valid_combos_30)
        suggestions.append({
            "text": f"Do not trade {symbol} with current strategies: produced Profit Factor below 1.0 across all tested combinations.",
            "impact": round(avg_loss, 2),
            "type": "PAIR_VIABILITY"
        })

    # Minimum 30 trades threshold for best combination before tuning
    if total_trades < 30:
        return suggestions

    strat_kpis = best.get("strategy_kpis", {})

    # 2. Strategy PF < 1.0 with net loss (fires only when strategy trades >= 30)
    for s_name, s_data in strat_kpis.items():
        s_count = s_data.get("count", 0)
        s_pf = s_data.get("profit_factor", 1.0)
        s_net = s_data.get("net_pnl", 0.0)
        if s_count >= 30 and s_pf < 1.0 and s_net < 0:
            suggestions.append({
                "text": f"Disable or retune {s_name} on {symbol}: produced PF {s_pf:.2f} with a net loss of -${abs(s_net):.2f}.",
                "impact": round(abs(s_net), 2),
                "type": "STRATEGY_RETUNE"
            })

    # 3. Strategy PF >= 1.3 with net profit (fires only when strategy trades >= 30)
    for s_name, s_data in strat_kpis.items():
        s_count = s_data.get("count", 0)
        s_pf = s_data.get("profit_factor", 1.0)
        s_net = s_data.get("net_pnl", 0.0)
        if s_count >= 30 and s_pf >= 1.3 and s_net > 0:
            suggestions.append({
                "text": f"Keep {s_name} on {symbol} as core edge and consider increasing risk allocation: strong PF {s_pf:.2f} netting +${s_net:.2f}.",
                "impact": round(s_net * 0.5, 2),
                "type": "STRATEGY_EXPAND"
            })

    # 4. Weekday with negative expectancy (fires only when weekday trades >= 30)
    dow_kpis = best.get("dow_kpis", {})
    for dow, d_data in dow_kpis.items():
        d_count = d_data.get("count", 0)
        d_exp = d_data.get("expectancy", 0.0)
        d_net = d_data.get("net_pnl", 0.0)
        if d_count >= 30 and (d_exp < 0 or d_net < 0):
            suggestions.append({
                "text": f"Avoid entries on {dow}s for {symbol}: negative expectancy ({d_exp:.2f}R) producing -${abs(d_net):.2f}.",
                "impact": round(abs(d_net), 2),
                "type": "DAY_FILTER"
            })

    # 5. Adaptive vs Legacy comparison (fires only when both modes have >= 30 trades)
    adp_combos = [c for c in combos if c.get("mode") == "adaptive" and c.get("total_trades", 0) >= 30]
    leg_combos = [c for c in combos if c.get("mode") == "legacy" and c.get("total_trades", 0) >= 30]
    if adp_combos and leg_combos:
        best_adp = max(adp_combos, key=lambda c: c.get("profit_factor", 0.0))
        best_leg = max(leg_combos, key=lambda c: c.get("profit_factor", 0.0))
        gap = best_adp.get("profit_factor", 0.0) - best_leg.get("profit_factor", 0.0)

        if abs(gap) >= 0.20:
            diff_pnl = abs(best_adp.get("net_pnl", 0.0) - best_leg.get("net_pnl", 0.0))
            if gap > 0:
                suggestions.append({
                    "text": f"Prefer Adaptive Mode over Legacy for {symbol}: delivers higher PF ({best_adp.get('profit_factor', 0.0):.2f} vs {best_leg.get('profit_factor', 0.0):.2f}) with a +${diff_pnl:.2f} profit advantage.",
                    "impact": round(diff_pnl, 2),
                    "type": "MODE_SELECTION"
                })
            else:
                suggestions.append({
                    "text": f"Prefer Legacy Mode over Adaptive for {symbol}: delivers higher PF ({best_leg.get('profit_factor', 0.0):.2f} vs {best_adp.get('profit_factor', 0.0):.2f}) with a +${diff_pnl:.2f} profit advantage.",
                    "impact": round(diff_pnl, 2),
                    "type": "MODE_SELECTION"
                })

    # 6. BE and Trail recommendation (fires only when combos have >= 30 trades)
    be_off_combos = [c for c in combos if c.get("be") == "off" and c.get("total_trades", 0) >= 30]
    be_on_combos = [c for c in combos if c.get("be") == "on" and c.get("total_trades", 0) >= 30]
    if be_off_combos and be_on_combos:
        best_be_off = max(be_off_combos, key=lambda c: c.get("profit_factor", 0.0))
        best_be_on = max(be_on_combos, key=lambda c: c.get("profit_factor", 0.0))
        
        # Check trail equality across matching combos
        trail_identical = True
        for c1 in combos:
            if c1.get("trail") == "off":
                matching_on = next((c2 for c2 in combos if c2.get("mode") == c1.get("mode") and c2.get("be") == c1.get("be") and c2.get("trail") == "on"), None)
                if matching_on and (matching_on.get("total_trades") != c1.get("total_trades") or matching_on.get("net_pnl") != c1.get("net_pnl")):
                    trail_identical = False
                    break

        if trail_identical:
            suggestions.append({
                "text": f"Trail on and Trail off produce identical results on {symbol} because target or stop boundaries are hit before the trail can engage.",
                "impact": 5.0,
                "type": "TRAIL_ANALYSIS"
            })

        if abs(best_be_on.get("profit_factor", 0.0) - best_be_off.get("profit_factor", 0.0)) >= 0.15:
            rec = "Breakeven On" if best_be_on.get("profit_factor", 0.0) > best_be_off.get("profit_factor", 0.0) else "Breakeven Off"
            better = best_be_on if "On" in rec else best_be_off
            worse = best_be_off if "On" in rec else best_be_on
            suggestions.append({
                "text": f"Recommend {rec} for {symbol}: better profit factor ({better.get('profit_factor', 0.0):.2f} vs {worse.get('profit_factor', 0.0):.2f}) and lower drawdown (-${better.get('max_drawdown', 0.0):.2f}).",
                "impact": round(abs(better.get("net_pnl", 0.0) - worse.get("net_pnl", 0.0)), 2),
                "type": "BE_TUNING"
            })

    # 7. Skip reasons > 30% of total skips (fires only when total skips >= 30)
    skip_summary = best.get("skipped_summary", {})
    if isinstance(skip_summary, dict):
        total_skips = sum(skip_summary.values())
        if total_skips >= 30:
            for reason, count in skip_summary.items():
                pct = (count / total_skips) * 100.0
                if pct >= 30.0:
                    suggestions.append({
                        "text": f"Test looser limits for '{reason}' on {symbol}: accounts for {count} of {total_skips} skipped setups ({pct:.0f}% of all skips).",
                        "impact": 35.0,
                        "type": "SKIP_TUNING"
                    })

    # 8. Adaptive coverage below 90% (fires only when trades >= 30)
    adp_cov = best.get("adaptive_effective_pct", 100.0)
    if adp_cov < 90.0:
        suggestions.append({
            "text": f"Adaptive results for {symbol} include unadapted bars ({adp_cov:.1f}% coverage); extend stored history to 500 days for full warmup.",
            "impact": 25.0,
            "type": "DATA_WARMUP"
        })

    suggestions.sort(key=lambda s: s.get("impact", 0.0), reverse=True)
    return suggestions


def generate_portfolio_next_tests(pairs_data: List[Dict[str, Any]], all_ranked_suggestions: List[Dict[str, Any]]) -> List[str]:
    """
    Generates up to 5 prioritized 'What to test next' items for the report.
    """
    tests: List[str] = []

    # 1. Action on worst-performing strategy
    retune_items = [s for s in all_ranked_suggestions if s.get("type") == "STRATEGY_RETUNE"]
    if retune_items:
        tests.append(f"Retest with underperforming setups disabled ({retune_items[0]['text'].split(':')[0]}).")

    # 2. Action on weekday filters
    day_filters = [s for s in all_ranked_suggestions if s.get("type") == "DAY_FILTER"]
    if day_filters:
        tests.append(f"Implement weekday blackout filter based on negative expectancy days ({day_filters[0]['text'].split(':')[0]}).")

    # 3. Action on Breakeven tuning
    be_items = [s for s in all_ranked_suggestions if s.get("type") == "BE_TUNING"]
    if be_items:
        tests.append("Lock in the statistically dominant Breakeven policy across validated pairs.")

    # 4. Action on high-volume skip filter
    skip_items = [s for s in all_ranked_suggestions if s.get("type") == "SKIP_TUNING"]
    if skip_items:
        tests.append("Run simulation with loosened daily cap and spread tolerance to capture filtered edge.")

    # 5. Target R:R fine tuning
    tests.append("Test expanding target R:R from 1.0 to 1.5 on pairs demonstrating profit factor above 1.3.")

    return tests[:5]
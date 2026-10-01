"""
backtest/advisor.py
Actionable Improvement Tips Advisor Engine.
Analyzes simulated historical trades across:
- MFE / MAE target realism (near-TP reversals vs premature exits)
- Noise stop-outs (post-SL recovery within 2 hours without adverse blowout)
- Time-of-day / session performance in SAST time
- Day-of-week win-rate and profit factor variations
- Asset/strategy edge viability over rolling 365 days
Outputs structured, plain-English advisory tips for the UI.
"""

import pandas as pd
import numpy as np
from datetime import datetime
from typing import List, Dict, Any

def generate_improvement_tips(trades: List[Dict[str, Any]], symbol: str, mode: str = "adaptive") -> List[Dict[str, Any]]:
    tips: List[Dict[str, Any]] = []
    if not trades or len(trades) < 10:
        return [{
            "id": f"tip_sample_size_{symbol.lower()}",
            "strategy": "ALL",
            "category": "SAMPLE_SIZE",
            "severity": "INFO",
            "title": f"Insufficient Trade Sample for {symbol}",
            "description": f"Only {len(trades)} trades recorded over the period. A minimum of 25-30 trades is recommended before drawing conclusions or altering live parameters.",
            "action": "Run simulation over a longer duration or allow more session opportunities."
        }]

    df = pd.DataFrame(trades)
    df["hour_sast"] = pd.to_datetime(df["signal_time_sast"]).dt.hour
    df["weekday"] = pd.to_datetime(df["date"]).dt.day_name()

    # =========================================================================
    # 1. TARGET REALISM & NEAR-TP REVERSAL ANALYSIS (MFE)
    # =========================================================================
    for strat, s_df in df.groupby("strategy"):
        losses = s_df[s_df["result"] == "LOSS"]
        if len(losses) >= 6:
            near_tp_count = len(losses[losses["failure_reason"] == "NEAR_TP_REVERSAL"])
            near_tp_pct = (near_tp_count / len(losses)) * 100.0
            avg_loss_mfe = float(losses["mfe_r"].mean())

            if near_tp_pct >= 35.0:
                tips.append({
                    "id": f"tip_{symbol.lower()}_{strat.lower()}_near_tp",
                    "strategy": strat,
                    "category": "TARGET_OPTIMIZATION",
                    "severity": "HIGH",
                    "title": f"{strat}: {near_tp_pct:.0f}% of losses reversed near Take Profit",
                    "description": (
                        f"Out of {len(losses)} losing trades, {near_tp_count} ({near_tp_pct:.0f}%) reached at least 75% of your target distance "
                        f"before turning around into a stop-out. On average, losing trades peaked at +{avg_loss_mfe:.2f}R in open profit."
                    ),
                    "action": f"Consider lowering TP1 or TP2 by 15-20% for {strat}, or taking a 50% partial close at +1.2R to lock in gains early."
                })

    # =========================================================================
    # 2. NOISE STOP-OUT & PREMATURE LIQUIDITY SWEEP RECOVERY
    # =========================================================================
    for strat, s_df in df.groupby("strategy"):
        losses = s_df[s_df["result"] == "LOSS"]
        if len(losses) >= 6:
            recovered_count = len(losses[losses["failure_reason"] == "NOISE_STOPOUT_RECOVERED"])
            recovered_pct = (recovered_count / len(losses)) * 100.0
            avg_mae_pips = float(losses["mae_pips"].mean())

            if recovered_pct >= 25.0:
                tips.append({
                    "id": f"tip_{symbol.lower()}_{strat.lower()}_noise_stop",
                    "strategy": strat,
                    "category": "STOP_LOSS_TUNING",
                    "severity": "HIGH",
                    "title": f"{strat}: {recovered_pct:.0f}% of stopped trades hit TP within 2 hours",
                    "description": (
                        f"{recovered_count} trades hit their stop loss, dipped less than 0.5x stop distance further (average adverse excursion: {avg_mae_pips:.1f} pips), "
                        f"and then rallied straight into your original target within 24 candles."
                    ),
                    "action": "Your stop loss is sitting directly inside broker/retail liquidity pockets. Consider adding a 0.03 x ADR buffer to your stop."
                })

    # =========================================================================
    # 3. TIME-OF-DAY & SESSION HOURS (SAST TIME)
    # =========================================================================
    hourly_stats = []
    for h, h_df in df.groupby("hour_sast"):
        cnt = len(h_df)
        if cnt >= 8:
            wins = len(h_df[h_df["result"] == "WIN"])
            wr = (wins / cnt) * 100.0
            net = float(h_df["money_pnl"].sum())
            hourly_stats.append((h, cnt, wr, net))

    # Flag poor performing hours
    for h, cnt, wr, net in hourly_stats:
        if wr <= 35.0 and net < 0:
            tips.append({
                "id": f"tip_{symbol.lower()}_time_hour_{h}",
                "strategy": "ALL",
                "category": "TIME_WINDOW",
                "severity": "MEDIUM",
                "title": f"Low Performance Window: {h:02d}:00 - {h+1:02d}:00 SAST",
                "description": (
                    f"Across {cnt} trades taken between {h:02d}:00 and {h+1:02d}:00 SAST, accuracy dropped to {wr:.1f}% "
                    f"resulting in a net realized drawdown of -${abs(net):.2f}."
                ),
                "action": f"Consider pausing new trade entries during the {h:02d}:00 SAST hour to avoid session overlap chop."
            })
        elif wr >= 65.0 and net > 0:
            tips.append({
                "id": f"tip_{symbol.lower()}_golden_hour_{h}",
                "strategy": "ALL",
                "category": "TIME_WINDOW",
                "severity": "INFO",
                "title": f"High Statistical Edge: {h:02d}:00 - {h+1:02d}:00 SAST",
                "description": (
                    f"Trades opened during {h:02d}:00 SAST generated a {wr:.1f}% win rate across {cnt} trades, "
                    f"netting +${net:.2f}."
                ),
                "action": f"Prioritize trade setups forming during this peak session hour."
            })

    # =========================================================================
    # 4. DAY-OF-THE-WEEK POLICY
    # =========================================================================
    for dow, dow_df in df.groupby("weekday"):
        cnt = len(dow_df)
        if cnt >= 15:
            wins = len(dow_df[dow_df["result"] == "WIN"])
            wr = (wins / cnt) * 100.0
            net = float(dow_df["money_pnl"].sum())
            if wr < 38.0 and net < 0:
                tips.append({
                    "id": f"tip_{symbol.lower()}_weekday_{dow.lower()}",
                    "strategy": "ALL",
                    "category": "WEEKDAY_POLICY",
                    "severity": "MEDIUM",
                    "title": f"Unfavorable Edge on {dow}s ({wr:.1f}% Win Rate)",
                    "description": (
                        f"{dow}s produced a net loss of -${abs(net):.2f} across {cnt} trades with below-average accuracy ({wr:.1f}%)."
                    ),
                    "action": f"Activate reduced risk sizing (e.g. 50% risk) or disable discretionary entries on {dow}s in session_config.py."
                })

    # =========================================================================
    # 5. OVERALL PAIR / STRATEGY VIABILITY (1-YEAR SAMPLING)
    # =========================================================================
    for strat, s_df in df.groupby("strategy"):
        cnt = len(s_df)
        if cnt >= 25:
            wins = len(s_df[s_df["result"] == "WIN"])
            wr = (wins / cnt) * 100.0
            net = float(s_df["money_pnl"].sum())
            gross_win = float(s_df[s_df["result"] == "WIN"]["money_pnl"].sum())
            gross_loss = float(abs(s_df[s_df["result"] == "LOSS"]["money_pnl"].sum()))
            pf = (gross_win / gross_loss) if gross_loss > 0 else 99.0

            if pf < 0.85 and net < 0:
                tips.append({
                    "id": f"tip_{symbol.lower()}_{strat.lower()}_viability",
                    "strategy": strat,
                    "category": "PAIR_VIABILITY",
                    "severity": "HIGH",
                    "title": f"Poor 1-Year Edge: {strat} on {symbol} (PF: {pf:.2f})",
                    "description": (
                        f"Over 365 days ({cnt} trades), {strat} on {symbol} produced a Profit Factor of only {pf:.2f} "
                        f"and net losses of -${abs(net):.2f}."
                    ),
                    "action": f"Switch {strat} to 'OFF' for {symbol} in the Dashboard Strategy Control switch."
                })

    return tips
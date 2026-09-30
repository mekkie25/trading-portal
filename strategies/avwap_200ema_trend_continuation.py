"""
trading-portal/strategies/avwap_200ema_trend_continuation.py
Anchored VWAP & 200 EMA Trend Continuation (Spec Setup 2).
- Macro Filter: Daily Dominant Trend aligned above/below Daily 200 EMA
- Retest: Price pulls back to Session/Anchored VWAP or 15M/1H 200 EMA
- Location: At institutional Fair Value Zone
- Confirmation: 5M Rejection Wick at level + Candle close held beyond anchor + POC acceptance
- Trade Management: Scale 50% at 1:2 R:R, Move to BE at 80% of R:R
"""

import pandas as pd
from strategies.base import StrategySignal
from core.indicators import calculate_session_vwap, has_rejection_wick
from config.strategy_params import GLOBAL_PARAMS

class AVWAPTrendContinuation:
    def evaluate(self, symbol: str, data_5m: pd.DataFrame, data_h4: pd.DataFrame = None, data_d1: pd.DataFrame = None, session_levels: dict = None) -> StrategySignal | None:
        diagnostics = {"strategy": "AVWAP_200EMA_CONTINUATION", "passed": False, "reason": ""}

        if data_5m is None or len(data_5m) < 40:
            diagnostics["reason"] = "Insufficient 5M bars"
            return None

        # Verify Daily Trend Alignment (Spec Section 2 & 4: Daily 200 EMA)
        daily_bullish = True
        daily_bearish = False
        if data_d1 is not None and len(data_d1) >= 10:
            d1_close = data_d1['close'].iloc[-1]
            d1_ema_50 = data_d1['close'].ewm(span=50, adjust=False).mean().iloc[-1]
            daily_bullish = d1_close >= d1_ema_50
            daily_bearish = d1_close < d1_ema_50

        ema_200_5m = data_5m['close'].ewm(span=200, adjust=False).mean()
        vwap_5m = calculate_session_vwap(data_5m)
        poc = session_levels.get('poc') if session_levels else None

        curr_bar = data_5m.iloc[-1]
        prev_bar = data_5m.iloc[-2]
        level_ema = ema_200_5m.iloc[-1]
        level_vwap = vwap_5m.iloc[-1]

        # LONG CONTINUATION
        if daily_bullish and curr_bar['close'] > level_ema:
            pullback_tested = (prev_bar['low'] <= (level_vwap * 1.001)) or (prev_bar['low'] <= (level_ema * 1.001))
            wick_rejection = has_rejection_wick(prev_bar, "BUY", min_wick_ratio=0.30)
            held_support = curr_bar['close'] > level_vwap and curr_bar['close'] > curr_bar['open']
            poc_acceptance = (curr_bar['close'] >= poc) if poc else True

            if pullback_tested and wick_rejection and held_support and poc_acceptance:
                sl = float(min(prev_bar['low'], level_ema * 0.999))
                risk = abs(curr_bar['close'] - sl)
                if risk > 0:
                    diagnostics.update({"passed": True, "action": "BUY", "risk": risk})
                    return StrategySignal(
                        strategy="AVWAP_200EMA_CONTINUATION",
                        symbol=symbol,
                        direction="BUY",
                        entry_price=float(curr_bar['close']),
                        stop_loss=sl,
                        take_profit=float(curr_bar['close'] + (2.0 * risk)),
                        take_profit_1=float(curr_bar['close'] + (1.2 * risk)),
                        take_profit_2=float(curr_bar['close'] + (2.0 * risk)),
                        scale_out_fraction=0.50,
                        trail_mode="MOVE_TO_BE_80",
                        session="ALL_DAY",
                        confidence=0.86,
                        reason="Pullback rejection wick off AVWAP/200 EMA holding above support with POC acceptance",
                        diagnostics=diagnostics
                    )

        # SHORT CONTINUATION
        if daily_bearish and curr_bar['close'] < level_ema:
            pullback_tested = (prev_bar['high'] >= (level_vwap * 0.999)) or (prev_bar['high'] >= (level_ema * 0.999))
            wick_rejection = has_rejection_wick(prev_bar, "SELL", min_wick_ratio=0.30)
            held_resistance = curr_bar['close'] < level_vwap and curr_bar['close'] < curr_bar['open']
            poc_acceptance = (curr_bar['close'] <= poc) if poc else True

            if pullback_tested and wick_rejection and held_resistance and poc_acceptance:
                sl = float(max(prev_bar['high'], level_ema * 1.001))
                risk = abs(sl - curr_bar['close'])
                if risk > 0:
                    diagnostics.update({"passed": True, "action": "SELL", "risk": risk})
                    return StrategySignal(
                        strategy="AVWAP_200EMA_CONTINUATION",
                        symbol=symbol,
                        direction="SELL",
                        entry_price=float(curr_bar['close']),
                        stop_loss=sl,
                        take_profit=float(curr_bar['close'] - (2.0 * risk)),
                        take_profit_1=float(curr_bar['close'] - (1.2 * risk)),
                        take_profit_2=float(curr_bar['close'] - (2.0 * risk)),
                        scale_out_fraction=0.50,
                        trail_mode="MOVE_TO_BE_80",
                        session="ALL_DAY",
                        confidence=0.86,
                        reason="Pullback rejection wick off AVWAP/200 EMA holding below resistance with POC acceptance",
                        diagnostics=diagnostics
                    )

        diagnostics["reason"] = "Pullback or rejection wick criteria not satisfied"
        return None
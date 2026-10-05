"""
trading-portal/strategies/strategy_513_cross.py
Mechanical 513 Strategy Crossover (Spec Setup 7).
- Timeframe: 5M / 15M
- Trigger: 5 EMA crosses 13 EMA (Fast cross on current bar)
- Structural Filter: Price at/above Daily Flip Level (Previous Day Close / Daily Equilibrium)
- Trend Benchmark: Aligned above 200 EMA for longs, below 200 EMA for shorts
- Confirmation: Candle close held beyond 13 EMA
- Reads precomputed EMAs from DataFrame columns if present, avoiding redundant calculations.
"""

import pandas as pd
from strategies.base import StrategySignal

class Strategy513:
    def evaluate(self, symbol: str, data_5m: pd.DataFrame, data_h4: pd.DataFrame = None, data_d1: pd.DataFrame = None, session_levels: dict = None) -> StrategySignal | None:
        diagnostics = {"strategy": "STRATEGY_513", "passed": False, "reason": ""}

        if data_5m is None or len(data_5m) < 35:
            diagnostics["reason"] = "Insufficient 5M candles"
            return None

        # Fast path: Read precomputed EMAs if available, otherwise compute via ewm
        if 'ema_5' in data_5m.columns and 'ema_13' in data_5m.columns and 'ema_200' in data_5m.columns:
            ema_5 = data_5m['ema_5']
            ema_13 = data_5m['ema_13']
            ema_200 = data_5m['ema_200']
        else:
            close = data_5m['close']
            ema_5 = close.ewm(span=5, adjust=False).mean()
            ema_13 = close.ewm(span=13, adjust=False).mean()
            ema_200 = close.ewm(span=200, adjust=False).mean()

        c_curr = data_5m.iloc[-1]
        current_200 = ema_200.iloc[-1]

        daily_flip = session_levels.get('daily_eq', session_levels.get('daily_pivot', current_200)) if session_levels else current_200

        bullish_cross = ema_5.iloc[-2] <= ema_13.iloc[-2] and ema_5.iloc[-1] > ema_13.iloc[-1]
        bearish_cross = ema_5.iloc[-2] >= ema_13.iloc[-2] and ema_5.iloc[-1] < ema_13.iloc[-1]

        # LONG 513
        if bullish_cross and c_curr['close'] > current_200 and c_curr['close'] >= daily_flip:
            if c_curr['close'] > ema_13.iloc[-1] and c_curr['close'] > c_curr['open']:
                sl = float(min(ema_13.iloc[-1], data_5m['low'].tail(5).min()))
                risk = abs(c_curr['close'] - sl)
                if risk > 0:
                    tp1 = float(c_curr['close'] + (1.5 * risk))
                    tp2 = float(c_curr['close'] + (2.0 * risk))

                    diagnostics.update({"passed": True, "action": "BUY", "flip_level": daily_flip})
                    return StrategySignal(
                        strategy="STRATEGY_513",
                        symbol=symbol,
                        direction="BUY",
                        entry_price=float(c_curr['close']),
                        stop_loss=sl,
                        take_profit=tp2,
                        take_profit_1=tp1,
                        take_profit_2=tp2,
                        scale_out_fraction=0.50,
                        trail_mode="MOVE_TO_BE_80",
                        session="ALL_DAY",
                        confidence=0.85,
                        reason="5/13 EMA Bullish Cross above Daily Flip level and 200 EMA",
                        diagnostics=diagnostics
                    )

        # SHORT 513
        if bearish_cross and c_curr['close'] < current_200 and c_curr['close'] <= daily_flip:
            if c_curr['close'] < ema_13.iloc[-1] and c_curr['close'] < c_curr['open']:
                sl = float(max(ema_13.iloc[-1], data_5m['high'].tail(5).max()))
                risk = abs(sl - c_curr['close'])
                if risk > 0:
                    tp1 = float(c_curr['close'] - (1.5 * risk))
                    tp2 = float(c_curr['close'] - (2.0 * risk))

                    diagnostics.update({"passed": True, "action": "SELL", "flip_level": daily_flip})
                    return StrategySignal(
                        strategy="STRATEGY_513",
                        symbol=symbol,
                        direction="SELL",
                        entry_price=float(c_curr['close']),
                        stop_loss=sl,
                        take_profit=tp2,
                        take_profit_1=tp1,
                        take_profit_2=tp2,
                        scale_out_fraction=0.50,
                        trail_mode="MOVE_TO_BE_80",
                        session="ALL_DAY",
                        confidence=0.85,
                        reason="5/13 EMA Bearish Cross below Daily Flip level and 200 EMA",
                        diagnostics=diagnostics
                    )

        diagnostics["reason"] = "No valid 5/13 crossover aligned with Daily Flip and 200 EMA"
        return None
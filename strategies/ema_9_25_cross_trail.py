"""
trading-portal/strategies/ema_9_25_cross_trail.py
Dynamic 9 EMA / 25 EMA Crossover with Pullback Confirmation (Spec Setup 4).
- Overall Bias aligned with 200 EMA
- Fast 9 EMA crosses 25 EMA
- Strict Retest Entry: Pullback to 9 or 25 EMA that HOLDS
- Reads precomputed EMAs from DataFrame columns if present, avoiding redundant calculations.
"""

import pandas as pd
from strategies.base import StrategySignal

class EMACrossTrail:
    def evaluate(self, symbol: str, data_5m: pd.DataFrame, data_h4: pd.DataFrame = None, data_d1: pd.DataFrame = None, session_levels: dict = None) -> StrategySignal | None:
        diagnostics = {"strategy": "EMA_9_25_CROSS", "passed": False, "reason": ""}

        if data_5m is None or len(data_5m) < 40:
            diagnostics["reason"] = "Insufficient 5M candle history"
            return None

        # Fast path: Read precomputed EMAs if available, otherwise compute via ewm
        if 'ema_9' in data_5m.columns and 'ema_25' in data_5m.columns and 'ema_200' in data_5m.columns:
            ema_9 = data_5m['ema_9']
            ema_25 = data_5m['ema_25']
            ema_200 = data_5m['ema_200']
        else:
            close = data_5m['close']
            ema_9 = close.ewm(span=9, adjust=False).mean()
            ema_25 = close.ewm(span=25, adjust=False).mean()
            ema_200 = close.ewm(span=200, adjust=False).mean()

        current_200 = ema_200.iloc[-1]

        recent = data_5m.tail(7)
        bullish_cross_idx = -1
        bearish_cross_idx = -1

        for i in range(1, len(recent) - 1):
            idx = recent.index[i]
            prev_idx = recent.index[i - 1]
            if ema_9.loc[prev_idx] <= ema_25.loc[prev_idx] and ema_9.loc[idx] > ema_25.loc[idx]:
                bullish_cross_idx = i
            if ema_9.loc[prev_idx] >= ema_25.loc[prev_idx] and ema_9.loc[idx] < ema_25.loc[idx]:
                bearish_cross_idx = i

        curr_bar = data_5m.iloc[-1]
        prev_bar = data_5m.iloc[-2]

        # BULLISH RETEST ENTRY
        if bullish_cross_idx != -1 and bullish_cross_idx < (len(recent) - 1):
            if curr_bar['close'] > current_200:
                tested_support = (prev_bar['low'] <= ema_9.iloc[-2]) or (prev_bar['low'] <= ema_25.iloc[-2])
                held_and_closed_up = curr_bar['close'] > curr_bar['open'] and curr_bar['close'] > ema_9.iloc[-1]

                if tested_support and held_and_closed_up:
                    sl = float(min(ema_25.iloc[-1], data_5m['low'].tail(4).min()))
                    risk = abs(curr_bar['close'] - sl)
                    if risk > 0:
                        diagnostics.update({"passed": True, "action": "BUY"})
                        return StrategySignal(
                            strategy="EMA_9_25_CROSS",
                            symbol=symbol,
                            direction="BUY",
                            entry_price=float(curr_bar['close']),
                            stop_loss=sl,
                            take_profit=float(curr_bar['close'] + (2.0 * risk)),
                            take_profit_1=float(curr_bar['close'] + (1.2 * risk)),
                            take_profit_2=float(curr_bar['close'] + (2.0 * risk)),
                            scale_out_fraction=0.50,
                            trail_mode="EMA_9",
                            session="ALL_DAY",
                            confidence=0.83,
                            reason="9/25 EMA bullish cross confirmed with pullback hold above 200 EMA",
                            diagnostics=diagnostics
                        )

        # BEARISH RETEST ENTRY
        if bearish_cross_idx != -1 and bearish_cross_idx < (len(recent) - 1):
            if curr_bar['close'] < current_200:
                tested_resistance = (prev_bar['high'] >= ema_9.iloc[-2]) or (prev_bar['high'] >= ema_25.iloc[-2])
                held_and_closed_down = curr_bar['close'] < curr_bar['open'] and curr_bar['close'] < ema_9.iloc[-1]

                if tested_resistance and held_and_closed_down:
                    sl = float(max(ema_25.iloc[-1], data_5m['high'].tail(4).max()))
                    risk = abs(sl - curr_bar['close'])
                    if risk > 0:
                        diagnostics.update({"passed": True, "action": "SELL"})
                        return StrategySignal(
                            strategy="EMA_9_25_CROSS",
                            symbol=symbol,
                            direction="SELL",
                            entry_price=float(curr_bar['close']),
                            stop_loss=sl,
                            take_profit=float(curr_bar['close'] - (2.0 * risk)),
                            take_profit_1=float(curr_bar['close'] - (1.2 * risk)),
                            take_profit_2=float(curr_bar['close'] - (2.0 * risk)),
                            scale_out_fraction=0.50,
                            trail_mode="EMA_9",
                            session="ALL_DAY",
                            confidence=0.83,
                            reason="9/25 EMA bearish cross confirmed with pullback hold below 200 EMA",
                            diagnostics=diagnostics
                        )

        diagnostics["reason"] = "No valid 9/25 crossover retest pattern"
        return None
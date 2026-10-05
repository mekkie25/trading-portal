"""
trading-portal/strategies/avwap_200ema_trend_continuation.py
Anchored VWAP (AVWAP) + 200 EMA Trend Continuation (Spec Setup 2).
- Trend Filter: 200 EMA defines the macro bias
- Anchor: Weekly AVWAP, anchored at session_levels["avwap_anchor_index"]
- Trigger: Pullback to AVWAP or 200 EMA that HOLDS in the trend direction
- Confirmation: 5M reaction candle (green hold above / red reject below)
- Stop: Beyond the pullback swing extremum, plus a small buffer
- Targets: TP1 at 1.5R, TP2 at 2.0R
- Trail: SuperTrend 5M (lets winners run)
"""

import pandas as pd
from strategies.base import StrategySignal
from core.indicators import calculate_anchored_vwap

try:
    from config.strategy_params import GLOBAL_PARAMS
except ImportError:
    from core.session_config import GLOBAL_PARAMS


class AVWAPTrendContinuation:
    def evaluate(
        self,
        symbol: str,
        data_5m: pd.DataFrame,
        data_h4: pd.DataFrame = None,
        data_d1: pd.DataFrame = None,
        session_levels: dict = None,
        data_h1: pd.DataFrame = None
    ) -> StrategySignal | None:
        diagnostics = {"strategy": "AVWAP_200EMA_CONTINUATION", "passed": False, "reason": ""}

        if data_5m is None or len(data_5m) < 50:
            diagnostics["reason"] = "Insufficient 5M candles"
            return None

        if not session_levels:
            diagnostics["reason"] = "Missing session levels"
            return None

        # Trend filter: 200 EMA (precomputed in backtest, calculated in live)
        if 'ema_200' in data_5m.columns:
            ema_200_series = data_5m['ema_200']
        else:
            ema_200_series = data_5m['close'].ewm(span=200, adjust=False).mean()

        current_200 = float(ema_200_series.iloc[-1])

        # Weekly anchored VWAP
        anchor_idx = session_levels.get("avwap_anchor_index", 0)
        try:
            anchor_idx = int(anchor_idx) if anchor_idx is not None else 0
        except (TypeError, ValueError):
            anchor_idx = 0

        if anchor_idx < 0 or anchor_idx >= len(data_5m):
            anchor_idx = 0

        avwap_series = calculate_anchored_vwap(data_5m, anchor_idx)
        avwap = avwap_series.iloc[-1]
        if pd.isna(avwap):
            diagnostics["reason"] = "AVWAP unavailable"
            return None
        avwap = float(avwap)

        curr = data_5m.iloc[-1]
        prev = data_5m.iloc[-2]

        # Tolerance band around structural levels
        adr = session_levels.get("adr")
        if GLOBAL_PARAMS.adaptive_mode and adr is not None and adr > 0:
            tolerance = 0.05 * adr
        else:
            tolerance = max(2.0, 0.001 * float(curr['close']))

        # ---------------- Bullish continuation ----------------
        bullish_trend = float(curr['close']) > current_200
        pulled_to_avwap = (
            abs(float(prev['low']) - avwap) <= tolerance
            or abs(float(prev['low']) - current_200) <= tolerance
        )
        held_and_bounced = (
            float(curr['close']) > float(curr['open'])
            and float(curr['close']) > avwap
        )

        if bullish_trend and pulled_to_avwap and held_and_bounced:
            sl = float(min(prev['low'], curr['low']) - (tolerance * 0.3))
            risk = abs(float(curr['close']) - sl)
            if risk > 0:
                tp1 = float(curr['close'] + (1.5 * risk))
                tp2 = float(curr['close'] + (2.0 * risk))
                diagnostics.update({"passed": True, "action": "BUY", "avwap": avwap})
                return StrategySignal(
                    strategy="AVWAP_200EMA_CONTINUATION",
                    symbol=symbol,
                    direction="BUY",
                    entry_price=float(curr['close']),
                    stop_loss=sl,
                    take_profit=tp2,
                    take_profit_1=tp1,
                    take_profit_2=tp2,
                    scale_out_fraction=0.50,
                    trail_mode="SUPERTREND",
                    session="ALL_DAY",
                    confidence=0.84,
                    reason="AVWAP/200 EMA bullish trend continuation on pullback hold",
                    diagnostics=diagnostics
                )

        # ---------------- Bearish continuation ----------------
        bearish_trend = float(curr['close']) < current_200
        pulled_to_avwap_resistance = (
            abs(float(prev['high']) - avwap) <= tolerance
            or abs(float(prev['high']) - current_200) <= tolerance
        )
        held_and_rejected = (
            float(curr['close']) < float(curr['open'])
            and float(curr['close']) < avwap
        )

        if bearish_trend and pulled_to_avwap_resistance and held_and_rejected:
            sl = float(max(prev['high'], curr['high']) + (tolerance * 0.3))
            risk = abs(sl - float(curr['close']))
            if risk > 0:
                tp1 = float(curr['close'] - (1.5 * risk))
                tp2 = float(curr['close'] - (2.0 * risk))
                diagnostics.update({"passed": True, "action": "SELL", "avwap": avwap})
                return StrategySignal(
                    strategy="AVWAP_200EMA_CONTINUATION",
                    symbol=symbol,
                    direction="SELL",
                    entry_price=float(curr['close']),
                    stop_loss=sl,
                    take_profit=tp2,
                    take_profit_1=tp1,
                    take_profit_2=tp2,
                    scale_out_fraction=0.50,
                    trail_mode="SUPERTREND",
                    session="ALL_DAY",
                    confidence=0.84,
                    reason="AVWAP/200 EMA bearish trend continuation on pullback rejection",
                    diagnostics=diagnostics
                )

        diagnostics["reason"] = "No AVWAP/200 EMA continuation setup"
        return None
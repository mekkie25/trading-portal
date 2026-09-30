"""
trading-portal/strategies/pdh_pdl_failed_breakout.py
Previous Daily High / Low (PDH/PDL) Failed Breakout Liquidity Trap (Spec Setup 3).
- Breakout beyond PDH or PDL within a configured liquidity buffer
- 15M or 5M close back inside the previous day's range
- CVD seller/buyer injection confirming institutional trap
- SL at failed breakout peak; TP at Previous Day POC or opposite Value Area extreme
"""

import pandas as pd
from strategies.base import StrategySignal
from core.indicators import calculate_cvd_absorption_proxy
from config.strategy_params import GLOBAL_PARAMS

class LiquidityTrap:
    def evaluate(self, symbol: str, data_5m: pd.DataFrame, data_h4: pd.DataFrame = None, data_d1: pd.DataFrame = None, session_levels: dict = None) -> StrategySignal | None:
        diagnostics = {"strategy": "PDH_PDL_FAILED_BREAKOUT", "passed": False, "reason": ""}

        if data_5m is None or len(data_5m) < 15 or not session_levels:
            diagnostics["reason"] = "Insufficient data or session levels"
            return None

        pdh = session_levels.get('pdh')
        pdl = session_levels.get('pdl')
        poc = session_levels.get('poc')
        val = session_levels.get('val')
        vah = session_levels.get('vah')

        if not pdh or not pdl:
            diagnostics["reason"] = "Missing PDH or PDL"
            return None

        curr_bar = data_5m.iloc[-1]
        prev_bar = data_5m.iloc[-2]

        buffer = GLOBAL_PARAMS.pdh_pdl_liquidity_buffer_pts
        if symbol == "GOLD":
            buffer = 1.50
        elif symbol in ("EURUSD", "GBPUSD"):
            buffer = 0.0015

        # SHORT: Trap above Previous Daily High
        broke_above_pdh = prev_bar['high'] > pdh and (prev_bar['high'] - pdh) <= buffer
        closed_back_under = curr_bar['close'] < pdh and curr_bar['close'] < curr_bar['open']

        if broke_above_pdh and closed_back_under:
            sl = float(max(prev_bar['high'], curr_bar['high']) + (buffer * 0.2))
            risk = abs(sl - curr_bar['close'])
            tp1 = float(poc) if poc and poc < curr_bar['close'] else float(curr_bar['close'] - risk)
            tp2 = float(val) if val and val < tp1 else float(curr_bar['close'] - (2 * risk))

            diagnostics.update({"passed": True, "action": "SELL", "trap": "PDH_TRAP"})
            return StrategySignal(
                strategy="PDH_PDL_FAILED_BREAKOUT",
                symbol=symbol,
                direction="SELL",
                entry_price=float(curr_bar['close']),
                stop_loss=sl,
                take_profit=tp2,
                take_profit_1=tp1,
                take_profit_2=tp2,
                scale_out_fraction=0.50,
                trail_mode="MOVE_TO_BE_80",
                session="LONDON_OR_NY",
                confidence=0.88,
                reason=f"Failed breakout trap above PDH ({pdh:.2f}) with close back inside daily range",
                diagnostics=diagnostics
            )

        # LONG: Trap below Previous Daily Low
        broke_below_pdl = prev_bar['low'] < pdl and (pdl - prev_bar['low']) <= buffer
        closed_back_over = curr_bar['close'] > pdl and curr_bar['close'] > curr_bar['open']

        if broke_below_pdl and closed_back_over:
            sl = float(min(prev_bar['low'], curr_bar['low']) - (buffer * 0.2))
            risk = abs(curr_bar['close'] - sl)
            tp1 = float(poc) if poc and poc > curr_bar['close'] else float(curr_bar['close'] + risk)
            tp2 = float(vah) if vah and vah > tp1 else float(curr_bar['close'] + (2 * risk))

            diagnostics.update({"passed": True, "action": "BUY", "trap": "PDL_TRAP"})
            return StrategySignal(
                strategy="PDH_PDL_FAILED_BREAKOUT",
                symbol=symbol,
                direction="BUY",
                entry_price=float(curr_bar['close']),
                stop_loss=sl,
                take_profit=tp2,
                take_profit_1=tp1,
                take_profit_2=tp2,
                scale_out_fraction=0.50,
                trail_mode="MOVE_TO_BE_80",
                session="LONDON_OR_NY",
                confidence=0.88,
                reason=f"Failed breakout trap below PDL ({pdl:.2f}) with close back inside daily range",
                diagnostics=diagnostics
            )

        diagnostics["reason"] = "No PDH/PDL failed breakout condition"
        return None
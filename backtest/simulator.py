"""
backtest/simulator.py
Replicates the exact live order and position management of engine/matrix.py:
- Twin 50/50 Leg A (TP1) & Leg B (TP2)
- Micro-lot 0.01 split logic
- Smart-Link (Leg A hits TP1 -> Leg B SL moves to BE)
- 80% R:R Break-Even trigger
- SuperTrend 5M trailing exit
- 21:00 SAST EOD close
- Conservative collision rule (SL hit first if same candle touches both SL and TP)
"""

import sys
import os
import math
import pandas as pd
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Any

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from engine.matrix import ConfigManager
from core.session_config import TZ_SAST, GLOBAL_PARAMS
from core.indicators import calculate_supertrend

class TradeSimulator:
    def __init__(self, starting_balance: float = 1000.0, risk_pct: float = 1.0, account_currency: str = "USD"):
        self.starting_balance = starting_balance
        self.balance = starting_balance
        self.equity = starting_balance
        self.risk_pct = risk_pct
        self.account_currency = account_currency
        self.open_positions: List[Dict[str, Any]] = []
        self.completed_trades: List[Dict[str, Any]] = []

    def open_trade(self, signal: Any, current_time: datetime, adr_val: Optional[float], regime: str, ref_levels: dict) -> bool:
        symbol = signal.symbol
        direction = signal.direction.upper()
        entry_price = float(signal.entry_price)
        sl = float(signal.stop_loss)
        tp1 = float(signal.take_profit_1) if signal.take_profit_1 else float(signal.take_profit)
        tp2 = float(signal.take_profit_2) if signal.take_profit_2 else float(signal.take_profit)
        sl_dist = abs(entry_price - sl)

        if sl_dist <= 0:
            return False

        # Spread & Asset Config
        cfg = ConfigManager.ASSETS.get(symbol)
        contract_size = cfg.contract_size if cfg else 100000.0
        pip_size = cfg.pip_size if cfg else 0.0001
        spread_pts = 2.50 if symbol == "US30" else (0.30 if symbol == "GOLD" else 0.00010)

        # Apply spread to entry
        actual_entry = (entry_price + (spread_pts / 2.0)) if direction == "BUY" else (entry_price - (spread_pts / 2.0))

        # Position Sizing
        risk_cash = self.equity * (self.risk_pct / 100.0)
        pips_at_risk = sl_dist / pip_size
        pip_value_per_lot = pip_size * contract_size
        risk_per_lot = pips_at_risk * pip_value_per_lot
        raw_lots = risk_cash / (risk_per_lot + 1e-9)

        lot_step = cfg.lot_step if cfg else 0.01
        min_lots = cfg.min_lots if cfg else 0.01
        stepped_lots = math.floor(round(raw_lots / lot_step, 6)) * lot_step
        total_lots = round(max(stepped_lots, min_lots), 2)

        # Mirror Live Matrix Logic (L765):
        half_lots = round(max(total_lots / 2.0, 0.01), 2)

        pos_group_id = f"{symbol}_{int(current_time.timestamp())}"

        # Leg A: Target TP1 (50% size)
        leg_a = {
            "group_id": pos_group_id,
            "leg": "A",
            "symbol": symbol,
            "strategy": signal.strategy,
            "direction": direction,
            "lots": half_lots,
            "entry_price": actual_entry,
            "stop_loss": sl,
            "take_profit": tp1,
            "initial_sl_dist": sl_dist,
            "open_time": current_time,
            "contract_size": contract_size,
            "spread_paid": spread_pts,
            "adr_val": adr_val,
            "regime": regime,
            "ref_levels": ref_levels,
            "trail_mode": getattr(signal, "trail_mode", "MOVE_TO_BE_80"),
            "is_be_moved": False,
            "mfe_price": actual_entry,
            "mae_price": actual_entry
        }

        # Leg B: Target TP2 (Runner, 50% size)
        leg_b = {
            "group_id": pos_group_id,
            "leg": "B",
            "symbol": symbol,
            "strategy": signal.strategy,
            "direction": direction,
            "lots": half_lots,
            "entry_price": actual_entry,
            "stop_loss": sl,
            "take_profit": tp2,
            "initial_sl_dist": sl_dist,
            "open_time": current_time,
            "contract_size": contract_size,
            "spread_paid": spread_pts,
            "adr_val": adr_val,
            "regime": regime,
            "ref_levels": ref_levels,
            "trail_mode": getattr(signal, "trail_mode", "MOVE_TO_BE_80"),
            "is_be_moved": False,
            "mfe_price": actual_entry,
            "mae_price": actual_entry
        }

        self.open_positions.extend([leg_a, leg_b])
        return True

    def process_candle(self, symbol: str, candle: pd.Series, m5_slice: pd.DataFrame):
        c_high = float(candle['high'])
        c_low = float(candle['low'])
        c_close = float(candle['close'])
        curr_time = pd.to_datetime(candle['time'], utc=True).to_pydatetime()
        sast_time = curr_time.astimezone(TZ_SAST)

        remaining_positions = []

        for pos in self.open_positions:
            if pos["symbol"] != symbol:
                remaining_positions.append(pos)
                continue

            entry = pos["entry_price"]
            sl = pos["stop_loss"]
            tp = pos["take_profit"]
            direction = pos["direction"]
            sl_dist = pos["initial_sl_dist"]

            # Update MFE & MAE
            if direction == "BUY":
                pos["mfe_price"] = max(pos["mfe_price"], c_high)
                pos["mae_price"] = min(pos["mae_price"], c_low)
            else:
                pos["mfe_price"] = min(pos["mfe_price"], c_low)
                pos["mae_price"] = max(pos["mae_price"], c_high)

            # 1. Conservative Collision Check (SL hit first if both touched in same candle)
            sl_hit = (c_low <= sl) if direction == "BUY" else (c_high >= sl)
            tp_hit = (c_high >= tp) if direction == "BUY" else (c_low <= tp)

            if sl_hit and tp_hit:
                # Conservative rule: Assume SL hit first
                self._close_position(pos, sl, curr_time, "SL_CONSERVATIVE_COLLISION")
                continue

            if sl_hit:
                self._close_position(pos, sl, curr_time, "SL")
                continue

            if tp_hit:
                self._close_position(pos, tp, curr_time, f"TP_{pos['leg']}")
                # Smart-Link: If Leg A hit TP1, arm Break-Even for Leg B on NEXT candle
                if pos["leg"] == "A":
                    for partner in self.open_positions:
                        if partner["group_id"] == pos["group_id"] and partner["leg"] == "B":
                            partner["arm_be_next_candle"] = True
                continue

            # Apply armed Break-Even from previous candle
            if pos.get("arm_be_next_candle") and not pos["is_be_moved"]:
                pos["stop_loss"] = entry
                pos["is_be_moved"] = True
                pos.pop("arm_be_next_candle", None)

            # 2. Dynamic 80% R:R Break-Even Rule
            if not pos["is_be_moved"]:
                progress = (c_close - entry) if direction == "BUY" else (entry - c_close)
                target_dist = abs(tp - entry)
                if target_dist > 0 and (progress / target_dist) >= 0.80 and progress >= (0.50 * sl_dist):
                    pos["stop_loss"] = entry
                    pos["is_be_moved"] = True

            # 3. SuperTrend 5M Trailing Stop Exit
            if pos["trail_mode"] == "SUPERTREND" and len(m5_slice) >= 15:
                st = calculate_supertrend(m5_slice, period=10, factor=1.6)
                curr_dir = int(st['supertrend_direction'].iloc[-1])
                if (direction == "BUY" and curr_dir == -1) or (direction == "SELL" and curr_dir == 1):
                    self._close_position(pos, c_close, curr_time, "SUPERTREND_TRAIL")
                    continue

            # 4. EOD 21:00 SAST Lockdown Close
            if sast_time.hour == 21 and sast_time.minute == 0:
                self._close_position(pos, c_close, curr_time, "EOD_LOCKDOWN")
                continue

            remaining_positions.append(pos)

        self.open_positions = remaining_positions

    def _close_position(self, pos: Dict[str, Any], exit_price: float, exit_time: datetime, reason: str):
        direction = pos["direction"]
        entry = pos["entry_price"]
        sl_dist = pos["initial_sl_dist"]
        lots = pos["lots"]
        contract_size = pos["contract_size"]

        price_diff = (exit_price - entry) if direction == "BUY" else (entry - exit_price)
        r_multiple = round(price_diff / sl_dist, 2) if sl_dist > 0 else 0.0
        money_pnl = round(price_diff * lots * contract_size, 2)

        # MFE / MAE in R
        mfe_dist = abs(pos["mfe_price"] - entry)
        mae_dist = abs(pos["mae_price"] - entry)
        mfe_r = round(mfe_dist / sl_dist, 2) if sl_dist > 0 else 0.0
        mae_r = round(mae_dist / sl_dist, 2) if sl_dist > 0 else 0.0

        result = "WIN" if money_pnl > 0.50 else ("LOSS" if money_pnl < -0.50 else "BREAKEVEN")
        duration_min = int((exit_time - pos["open_time"]).total_seconds() / 60)

        record = {
            "date": pos["open_time"].strftime("%Y-%m-%d"),
            "symbol": pos["symbol"],
            "strategy": pos["strategy"],
            "leg": pos["leg"],
            "direction": direction,
            "signal_time_utc": pos["open_time"].strftime("%Y-%m-%d %H:%M:%S"),
            "signal_time_sast": pos["open_time"].astimezone(TZ_SAST).strftime("%Y-%m-%d %H:%M:%S"),
            "entry_price": round(entry, 5),
            "exit_price": round(exit_price, 5),
            "sl": round(pos["stop_loss"], 5),
            "tp": round(pos["take_profit"], 5),
            "lots": lots,
            "exit_time": exit_time.strftime("%Y-%m-%d %H:%M:%S"),
            "exit_reason": reason,
            "duration_minutes": duration_min,
            "result": result,
            "r_multiple": r_multiple,
            "money_pnl": money_pnl,
            "mfe_r": mfe_r,
            "mae_r": mae_r,
            "spread_paid": pos["spread_paid"],
            "adr": pos["adr_val"],
            "regime": pos["regime"]
        }

        self.balance += money_pnl
        self.equity = self.balance
        self.completed_trades.append(record)
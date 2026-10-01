"""
backtest/simulator.py
Replicates the exact live order and position management of engine/matrix.py:
- Twin 50/50 Leg A (TP1) & Leg B (TP2)
- Micro-lot 0.01 split logic
- Smart-Link (Leg A hits TP1 -> Leg B SL moves to BE on next candle)
- 80% R:R Break-Even trigger
- SuperTrend 5M trailing exit
- 21:00 SAST EOD close
- Conservative collision rule (SL hit first if same candle touches both SL and TP)
- Detailed Trade Metrics: MFE/MAE in R & pips, Profit-First detection,
  and strict 2-hour post-SL recovery tracking with adverse limits.
"""

import sys
import os
import math
import pandas as pd
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Any

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from core.session_config import TZ_SAST, GLOBAL_PARAMS
from core.indicators import calculate_supertrend

# Whitelist asset specifications
ASSETS = {
    "GOLD": {"pip_size": 0.01, "contract_size": 100.0, "min_lots": 0.01, "lot_step": 0.01, "spread": 0.30},
    "US30": {"pip_size": 1.0, "contract_size": 1.0, "min_lots": 0.01, "lot_step": 0.01, "spread": 2.50},
    "NAS100": {"pip_size": 0.1, "contract_size": 1.0, "min_lots": 0.01, "lot_step": 0.01, "spread": 1.50},
    "GERMAN30": {"pip_size": 0.1, "contract_size": 1.0, "min_lots": 0.01, "lot_step": 0.01, "spread": 1.80},
    "EURUSD": {"pip_size": 0.0001, "contract_size": 100000.0, "min_lots": 0.01, "lot_step": 0.01, "spread": 0.00010},
    "USDJPY": {"pip_size": 0.01, "contract_size": 100000.0, "min_lots": 0.01, "lot_step": 0.01, "spread": 0.012},
    "GBPUSD": {"pip_size": 0.0001, "contract_size": 100000.0, "min_lots": 0.01, "lot_step": 0.01, "spread": 0.00014},
}

class TradeSimulator:
    def __init__(self, starting_balance: float = 1000.0, risk_pct: float = 1.0, account_currency: str = "USD"):
        self.starting_balance = starting_balance
        self.balance = starting_balance
        self.equity = starting_balance
        self.risk_pct = risk_pct
        self.account_currency = account_currency
        self.open_positions: List[Dict[str, Any]] = []
        self.completed_trades: List[Dict[str, Any]] = []
        self.pending_sl_evaluations: List[Dict[str, Any]] = []

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

        cfg = ASSETS.get(symbol, {"pip_size": 0.0001, "contract_size": 100000.0, "min_lots": 0.01, "lot_step": 0.01, "spread": 0.0001})
        contract_size = cfg["contract_size"]
        pip_size = cfg["pip_size"]
        spread_pts = cfg["spread"]

        actual_entry = (entry_price + (spread_pts / 2.0)) if direction == "BUY" else (entry_price - (spread_pts / 2.0))

        risk_cash = self.equity * (self.risk_pct / 100.0)
        pips_at_risk = sl_dist / pip_size
        pip_value_per_lot = pip_size * contract_size
        risk_per_lot = pips_at_risk * pip_value_per_lot
        raw_lots = risk_cash / (risk_per_lot + 1e-9)

        lot_step = cfg["lot_step"]
        min_lots = cfg["min_lots"]
        stepped_lots = math.floor(round(raw_lots / lot_step, 6)) * lot_step
        total_lots = round(max(stepped_lots, min_lots), 2)

        half_lots = round(max(total_lots / 2.0, 0.01), 2)
        pos_group_id = f"{symbol}_{int(current_time.timestamp())}"

        base_leg = {
            "group_id": pos_group_id,
            "symbol": symbol,
            "strategy": signal.strategy,
            "direction": direction,
            "lots": half_lots,
            "entry_price": actual_entry,
            "stop_loss": sl,
            "initial_sl_dist": sl_dist,
            "open_time": current_time,
            "contract_size": contract_size,
            "pip_size": pip_size,
            "spread_paid": spread_pts,
            "adr_val": adr_val,
            "regime": regime,
            "ref_levels": ref_levels,
            "trail_mode": getattr(signal, "trail_mode", "MOVE_TO_BE_80"),
            "is_be_moved": False,
            "mfe_price": actual_entry,
            "mae_price": actual_entry,
            "profit_seen": False,
            "loss_seen": False,
            "profit_first": False
        }

        leg_a = {**base_leg, "leg": "A", "take_profit": tp1}
        leg_b = {**base_leg, "leg": "B", "take_profit": tp2}

        self.open_positions.extend([leg_a, leg_b])
        return True

    def process_candle(self, symbol: str, candle: pd.Series, m5_slice: pd.DataFrame):
        c_high = float(candle['high'])
        c_low = float(candle['low'])
        c_close = float(candle['close'])
        curr_time = pd.to_datetime(candle['time'], utc=True).to_pydatetime()
        sast_time = curr_time.astimezone(TZ_SAST)

        # 1. Update in-flight open positions
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

            # Update MFE, MAE, and Profit-First flags
            if direction == "BUY":
                pos["mfe_price"] = max(pos["mfe_price"], c_high)
                pos["mae_price"] = min(pos["mae_price"], c_low)
                if c_high > entry and not pos["loss_seen"]:
                    pos["profit_first"] = True
                if c_high > entry:
                    pos["profit_seen"] = True
                if c_low < entry:
                    pos["loss_seen"] = True
            else:
                pos["mfe_price"] = min(pos["mfe_price"], c_low)
                pos["mae_price"] = max(pos["mae_price"], c_high)
                if c_low < entry and not pos["loss_seen"]:
                    pos["profit_first"] = True
                if c_low < entry:
                    pos["profit_seen"] = True
                if c_high > entry:
                    pos["loss_seen"] = True

            # Apply armed Break-Even from previous candle
            if pos.get("arm_be_next_candle") and not pos["is_be_moved"]:
                pos["stop_loss"] = entry
                pos["is_be_moved"] = True
                sl = entry
                pos.pop("arm_be_next_candle", None)

            # Collision Check (Conservative: SL hit first)
            sl_hit = (c_low <= sl) if direction == "BUY" else (c_high >= sl)
            tp_hit = (c_high >= tp) if direction == "BUY" else (c_low <= tp)

            if sl_hit and tp_hit:
                self._close_position(pos, sl, curr_time, "SL_CONSERVATIVE_COLLISION")
                continue

            if sl_hit:
                self._close_position(pos, sl, curr_time, "SL")
                continue

            if tp_hit:
                self._close_position(pos, tp, curr_time, f"TP_{pos['leg']}")
                if pos["leg"] == "A":
                    for partner in self.open_positions:
                        if partner["group_id"] == pos["group_id"] and partner["leg"] == "B":
                            partner["arm_be_next_candle"] = True
                continue

            # Dynamic 80% R:R Break-Even Rule
            if not pos["is_be_moved"]:
                progress = (c_close - entry) if direction == "BUY" else (entry - c_close)
                target_dist = abs(tp - entry)
                if target_dist > 0 and (progress / target_dist) >= 0.80 and progress >= (0.50 * sl_dist):
                    pos["stop_loss"] = entry
                    pos["is_be_moved"] = True

            # SuperTrend 5M Trailing Stop Exit
            if pos["trail_mode"] == "SUPERTREND" and len(m5_slice) >= 15:
                st = calculate_supertrend(m5_slice, period=10, factor=1.6)
                curr_dir = int(st['supertrend_direction'].iloc[-1])
                if (direction == "BUY" and curr_dir == -1) or (direction == "SELL" and curr_dir == 1):
                    self._close_position(pos, c_close, curr_time, "SUPERTREND_TRAIL")
                    continue

            # EOD 21:00 SAST Lockdown Close
            if sast_time.hour == 21 and sast_time.minute == 0:
                self._close_position(pos, c_close, curr_time, "EOD_LOCKDOWN")
                continue

            remaining_positions.append(pos)

        self.open_positions = remaining_positions

        # 2. Strict Post-SL Recovery Monitor (Max 2 hours, max 0.5x SL adverse breach)
        active_pending = []
        for pending in self.pending_sl_evaluations:
            if pending["symbol"] != symbol:
                active_pending.append(pending)
                continue

            direction = pending["direction"]
            target_tp = pending["target_tp"]
            max_adverse = pending["max_adverse_allowed"]

            # Check if market blew past adverse tolerance
            if not pending["adverse_blown"]:
                if direction == "BUY" and c_low <= max_adverse:
                    pending["adverse_blown"] = True
                elif direction == "SELL" and c_high >= max_adverse:
                    pending["adverse_blown"] = True

            # If adverse move was modest, check if it reached original TP within 2 hours
            if not pending["adverse_blown"]:
                reached_tp = (c_high >= target_tp) if direction == "BUY" else (c_low <= target_tp)
                if reached_tp:
                    pending["record"]["failure_reason"] = "NOISE_STOPOUT_RECOVERED"
                    pending["record"]["recovered_to_tp"] = True
                    pending["bars_remaining"] = 0

            pending["bars_remaining"] -= 1

            if pending["bars_remaining"] > 0 and not (sast_time.hour == 21 and sast_time.minute == 0):
                active_pending.append(pending)

        self.pending_sl_evaluations = active_pending

    def _close_position(self, pos: Dict[str, Any], exit_price: float, exit_time: datetime, reason: str):
        direction = pos["direction"]
        entry = pos["entry_price"]
        sl_dist = pos["initial_sl_dist"]
        lots = pos["lots"]
        contract_size = pos["contract_size"]
        pip_size = pos.get("pip_size", 0.01)

        price_diff = (exit_price - entry) if direction == "BUY" else (entry - exit_price)
        r_multiple = round(price_diff / sl_dist, 2) if sl_dist > 0 else 0.0
        money_pnl = round(price_diff * lots * contract_size, 2)

        # MFE and MAE calculations
        if direction == "BUY":
            mfe_dist = max(0.0, pos["mfe_price"] - entry)
            mae_dist = max(0.0, entry - pos["mae_price"])
        else:
            mfe_dist = max(0.0, entry - pos["mfe_price"])
            mae_dist = max(0.0, pos["mae_price"] - entry)

        mfe_r = round(mfe_dist / sl_dist, 2) if sl_dist > 0 else 0.0
        mae_r = round(mae_dist / sl_dist, 2) if sl_dist > 0 else 0.0
        mfe_pips = round(mfe_dist / pip_size, 1) if pip_size > 0 else 0.0
        mae_pips = round(mae_dist / pip_size, 1) if pip_size > 0 else 0.0

        result = "WIN" if money_pnl > 0.50 else ("LOSS" if money_pnl < -0.50 else "BREAKEVEN")
        duration_min = int((exit_time - pos["open_time"]).total_seconds() / 60)

        # Initial failure categorization
        target_dist = abs(pos["take_profit"] - entry)
        if result == "WIN":
            failure_reason = "NONE_WIN"
        elif target_dist > 0 and (mfe_dist / target_dist) >= 0.75:
            failure_reason = "NEAR_TP_REVERSAL"
        elif mfe_r < 0.25:
            failure_reason = "STRAIGHT_DRAWDOWN"
        else:
            failure_reason = "CLEAN_LOSS"

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
            "mfe_pips": mfe_pips,
            "mae_pips": mae_pips,
            "profit_first": pos["profit_first"],
            "failure_reason": failure_reason,
            "recovered_to_tp": False,
            "spread_paid": pos["spread_paid"],
            "adr": pos["adr_val"],
            "regime": pos["regime"]
        }

        # If trade stopped out, register for strict 24-candle post-SL tracking
        if result == "LOSS" and "SL" in reason:
            max_adverse = (pos["stop_loss"] - (0.50 * sl_dist)) if direction == "BUY" else (pos["stop_loss"] + (0.50 * sl_dist))
            self.pending_sl_evaluations.append({
                "record": record,
                "symbol": pos["symbol"],
                "direction": direction,
                "target_tp": pos["take_profit"],
                "max_adverse_allowed": max_adverse,
                "adverse_blown": False,
                "bars_remaining": 24,
                "pip_size": pip_size
            })

        self.balance += money_pnl
        self.equity = self.balance
        self.completed_trades.append(record)
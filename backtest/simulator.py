"""
backtest/simulator.py
Replicates the exact single-order live position management of engine/matrix.py.

PROPOSED: alt-target replay. When the simulator is constructed with the full
M5 series (m5_df_full=...), every closed trade gets four additional fields
(alt_r_1, alt_r_15, alt_r_2, alt_r_3) plus a boolean alt_timeout.

PROPOSED: post-exit tracking replaces the old fixed 24-candle window with
two clean rules:
  - After a SL exit: track until price reaches the original TP (recovered),
    OR until price has moved 2x the original SL distance further past the SL,
    OR the end of the data.
  - After a TP exit: track until price returns to entry (invalid),
    OR until price has moved 3x the original TP distance past the TP,
    OR the end of the data.

PROPOSED (2026-10-10): the alt-target replay now uses `pos["open_time"]`
converted to epoch seconds via datetime.timestamp(). It no longer reads
record["signal_time_utc"] and parses it. The previous version was silently
returning early on pandas versions where the datetime column conversion
raised inside a broad except, which produced null alt_r_* fields on
every trade. On any failure, the init path now prints a visible traceback
so a silent failure cannot happen again.
"""

import sys
import os
import math
import bisect
import traceback
import numpy as np
import pandas as pd
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Any

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from core.session_config import TZ_SAST, GLOBAL_PARAMS, MarketSessionManager
from core.indicators import calculate_supertrend
from core.targets import compute_fixed_target
from core.pip_sizes import PIP_SIZES

POST_SL_CAP_MULTIPLE = 2.0
POST_TP_CAP_MULTIPLE = 3.0

ALT_MAX_HOLD_CANDLES = 5 * 288
ALT_TIMEOUT_FLAG_KEY = "alt_timeout"
ALT_TARGET_KEYS = ("alt_r_1", "alt_r_15", "alt_r_2", "alt_r_3")

ASSETS = {
    "GOLD":     {"pip_size": PIP_SIZES["GOLD"],     "contract_size": 100.0,    "min_lots": 0.01, "lot_step": 0.01, "spread": 0.30},
    "US30":     {"pip_size": PIP_SIZES["US30"],     "contract_size": 1.0,      "min_lots": 0.01, "lot_step": 0.01, "spread": 2.50},
    "NAS100":   {"pip_size": PIP_SIZES["NAS100"],   "contract_size": 1.0,      "min_lots": 0.01, "lot_step": 0.01, "spread": 1.50},
    "GERMAN30": {"pip_size": PIP_SIZES["GERMAN30"], "contract_size": 1.0,      "min_lots": 0.01, "lot_step": 0.01, "spread": 1.80},
    "EURUSD":   {"pip_size": PIP_SIZES["EURUSD"],   "contract_size": 100000.0, "min_lots": 0.01, "lot_step": 0.01, "spread": 0.00010},
    "USDJPY":   {"pip_size": PIP_SIZES["USDJPY"],   "contract_size": 100000.0, "min_lots": 0.01, "lot_step": 0.01, "spread": 0.012},
    "GBPUSD":   {"pip_size": PIP_SIZES["GBPUSD"],   "contract_size": 100000.0, "min_lots": 0.01, "lot_step": 0.01, "spread": 0.00014},
}


class TradeSimulator:
    def __init__(
        self,
        starting_balance: float = 1000.0,
        risk_pct: float = 1.0,
        account_currency: str = "USD",
        eurusd_df: Optional[pd.DataFrame] = None,
        be_mode: str = "FIXED_80",
        m5_df_full: Optional[pd.DataFrame] = None,
    ):
        self.starting_balance = starting_balance
        self.balance = starting_balance
        self.equity = starting_balance
        self.risk_pct = risk_pct
        self.account_currency = account_currency
        self.be_mode = be_mode
        self.open_positions: List[Dict[str, Any]] = []
        self.completed_trades: List[Dict[str, Any]] = []
        self.pending_sl_evaluations: List[Dict[str, Any]] = []
        self.skipped: List[Dict[str, Any]] = []
        self.daily_trade_counts: Dict[str, int] = {}
        self._trade_counter: int = 0

        self._eurusd_times: List[float] = []
        self._eurusd_prices: List[float] = []
        if eurusd_df is not None and not eurusd_df.empty:
            df_e = eurusd_df.copy()
            if not pd.api.types.is_datetime64_any_dtype(df_e['time']):
                df_e['time'] = pd.to_datetime(df_e['time'], utc=True)
            df_e.sort_values('time', inplace=True)
            self._eurusd_times = [t.timestamp() for t in df_e['time']]
            self._eurusd_prices = [float(p) for p in df_e['close']]

        self._m5_epochs: Optional[np.ndarray] = None
        self._m5_highs: Optional[np.ndarray] = None
        self._m5_lows: Optional[np.ndarray] = None
        self._m5_closes: Optional[np.ndarray] = None

        if m5_df_full is not None and not m5_df_full.empty:
            try:
                df = m5_df_full.copy()
                if not pd.api.types.is_datetime64_any_dtype(df['time']):
                    df['time'] = pd.to_datetime(df['time'], utc=True)
                df = df.sort_values('time').reset_index(drop=True)
                # Robust epoch conversion: never rely on pandas .astype(int64)
                # on a tz-aware column. Use .value (nanoseconds since epoch)
                # and integer-divide.
                epochs = np.empty(len(df), dtype=np.int64)
                for i, t in enumerate(df['time']):
                    try:
                        epochs[i] = int(getattr(t, "value", 0)) // 10 ** 9
                    except Exception:
                        epochs[i] = 0
                self._m5_epochs = epochs
                self._m5_highs = df['high'].astype(float).to_numpy()
                self._m5_lows = df['low'].astype(float).to_numpy()
                self._m5_closes = df['close'].astype(float).to_numpy()
                # One-shot visible log. The user can see this in the deploy
                # logs and it proves the arrays were built.
                print(
                    f"[simulator] alt replay ready: {len(epochs)} candles, "
                    f"first={epochs[0] if len(epochs) > 0 else 'n/a'}, "
                    f"last={epochs[-1] if len(epochs) > 0 else 'n/a'}",
                    flush=True,
                )
                if self._m5_epochs.size == 0:
                    print("[simulator] WARNING: alt replay disabled (empty epoch array).", flush=True)
            except Exception as e:
                print(f"[simulator] WARNING: alt replay disabled ({e}).", flush=True)
                traceback.print_exc()
                self._m5_epochs = None
                self._m5_highs = None
                self._m5_lows = None
                self._m5_closes = None

    def _get_eurusd_rate_at_or_before(self, dt: datetime) -> Optional[float]:
        if not self._eurusd_times:
            return None
        target_epoch = dt.timestamp()
        idx = bisect.bisect_right(self._eurusd_times, target_epoch) - 1
        if idx >= 0:
            return self._eurusd_prices[idx]
        return None

    def skip_summary(self) -> Dict[str, Any]:
        by_reason_candles: Dict[str, int] = {}
        by_reason_setups: Dict[str, set] = {}
        by_strategy: Dict[str, int] = {}
        by_hour_sast: Dict[int, int] = {}

        for s in self.skipped:
            reason = s.get("reason", "UNKNOWN")
            strat = s.get("strategy", "UNKNOWN")
            direction = s.get("direction", "UNKNOWN")
            day = s.get("date_sast", s.get("time", "")[:10])
            h = s.get("hour_sast", 0)

            by_reason_candles[reason] = by_reason_candles.get(reason, 0) + 1
            if reason not in by_reason_setups:
                by_reason_setups[reason] = set()
            by_reason_setups[reason].add((strat, direction, day))

            by_strategy[strat] = by_strategy.get(strat, 0) + 1
            by_hour_sast[h] = by_hour_sast.get(h, 0) + 1

        by_reason_detail: Dict[str, Dict[str, int]] = {}
        for r, c_cnt in by_reason_candles.items():
            by_reason_detail[r] = {
                "candle_skips": c_cnt,
                "unique_setups": len(by_reason_setups.get(r, set()))
            }

        return {
            "by_reason": by_reason_detail,
            "by_strategy": by_strategy,
            "by_hour_sast": by_hour_sast
        }

    def _record_skip(self, current_time: datetime, symbol: str, strategy: str, reason: str, direction: str = "UNKNOWN") -> bool:
        sast_time = current_time.astimezone(TZ_SAST)
        sast_date_str = sast_time.strftime("%Y-%m-%d")
        sast_hour = sast_time.hour
        self.skipped.append({
            "time": current_time.strftime("%Y-%m-%d %H:%M:%S"),
            "date_sast": sast_date_str,
            "symbol": symbol,
            "strategy": strategy,
            "direction": direction,
            "reason": reason,
            "hour_sast": sast_hour
        })
        return False

    def open_trade(
        self,
        signal: Any,
        current_time: datetime,
        adr_val: Optional[float],
        regime: str,
        ref_levels: dict,
        ema_200_value: Optional[float] = None,
        entry_features: Optional[Dict[str, Any]] = None,
    ) -> bool:
        symbol = signal.symbol
        direction = signal.direction.upper()
        strategy = getattr(signal, "strategy", "UNKNOWN")
        entry_price = float(signal.entry_price)
        sl = float(signal.stop_loss)
        sl_dist = abs(entry_price - sl)

        if sl_dist <= 0:
            return self._record_skip(current_time, symbol, strategy, "INVALID_SL_DIST", direction)

        sast_time = current_time.astimezone(TZ_SAST)
        sast_date_str = sast_time.strftime("%Y-%m-%d")
        current_daily_count = self.daily_trade_counts.get(sast_date_str, 0)
        max_daily = getattr(GLOBAL_PARAMS, 'max_daily_trades', 2)
        if current_daily_count >= max_daily:
            return self._record_skip(current_time, symbol, strategy, "DAILY_CAP", direction)

        fixed_tp = compute_fixed_target(signal, GLOBAL_PARAMS.target_rr, use_final_target=GLOBAL_PARAMS.adaptive_mode)
        if fixed_tp is None:
            return self._record_skip(current_time, symbol, strategy, "NO_ROOM", direction)

        cfg = ASSETS.get(symbol, {"pip_size": 0.0001, "contract_size": 100000.0, "min_lots": 0.01, "lot_step": 0.01, "spread": 0.0001})
        contract_size = cfg["contract_size"]
        pip_size = cfg["pip_size"]
        spread_pts = cfg["spread"]

        actual_entry = (entry_price + (spread_pts / 2.0)) if direction == "BUY" else (entry_price - (spread_pts / 2.0))

        if symbol == "USDJPY":
            fx_rate = (1.0 / entry_price) if entry_price > 0 else 1.0
        elif symbol == "GERMAN30":
            rate = self._get_eurusd_rate_at_or_before(current_time)
            if rate is None or rate <= 0:
                return self._record_skip(current_time, symbol, strategy, "UNSUPPORTED_SYMBOL_NO_FX", direction)
            fx_rate = rate
        else:
            fx_rate = 1.0

        risk_cash = self.equity * (self.risk_pct / 100.0)
        pips_at_risk = sl_dist / pip_size
        pip_value_per_lot = (pip_size * contract_size) * fx_rate
        risk_per_lot = pips_at_risk * pip_value_per_lot
        raw_lots = risk_cash / (risk_per_lot + 1e-9)

        lot_step = cfg["lot_step"]
        min_lots = cfg["min_lots"]
        tolerance = getattr(GLOBAL_PARAMS, 'min_lot_risk_tolerance', 1.5)

        if raw_lots < min_lots:
            min_lot_cash_risk = min_lots * risk_per_lot
            if min_lot_cash_risk > (tolerance * risk_cash):
                return self._record_skip(current_time, symbol, strategy, "MIN_LOT_TOO_RISKY", direction)
            total_lots = min_lots
        else:
            stepped_lots = math.floor(round(raw_lots / lot_step, 6)) * lot_step
            total_lots = round(max(stepped_lots, min_lots), 2)

        eod_deadline = sast_time.replace(hour=21, minute=0, second=0, microsecond=0)
        if sast_time >= eod_deadline:
            eod_deadline += timedelta(days=1)

        self._trade_counter += 1
        trade_id = f"{symbol}_{int(current_time.timestamp())}_{self._trade_counter}"

        alignment = "UNKNOWN"
        if ema_200_value is not None and ema_200_value > 0:
            if direction == "BUY":
                alignment = "BULLISH_ALIGNED" if entry_price > ema_200_value else "COUNTER_TREND"
            else:
                alignment = "BEARISH_ALIGNED" if entry_price < ema_200_value else "COUNTER_TREND"

        confirmation_type = getattr(signal, "confirmation_type", "CLOSE")

        try:
            is_in_news, _ = MarketSessionManager.is_blackout_active(current_time)
        except Exception:
            is_in_news = False

        # PROPOSED: entry_epoch is captured here as a plain integer number of
        # seconds. The alt-target replay uses this directly, so no string
        # parsing and no timezone conversion is done at replay time.
        try:
            entry_epoch = int(current_time.timestamp())
        except Exception:
            entry_epoch = 0

        position = {
            "trade_id": trade_id,
            "symbol": symbol,
            "strategy": strategy,
            "direction": direction,
            "lots": total_lots,
            "entry_price": actual_entry,
            "stop_loss": sl,
            "take_profit": fixed_tp,
            "initial_sl_dist": sl_dist,
            "open_time": current_time,
            "entry_epoch": entry_epoch,
            "contract_size": contract_size,
            "pip_size": pip_size,
            "spread_pts": spread_pts,
            "adr_val": adr_val,
            "regime": regime,
            "ref_levels": ref_levels,
            "trail_mode": getattr(signal, "trail_mode", "MOVE_TO_BE_80"),
            "is_be_moved": False,
            "mfe_price": actual_entry,
            "mae_price": actual_entry,
            "profit_seen": False,
            "loss_seen": False,
            "profit_first": False,
            "eod_deadline_sast": eod_deadline,
            "ema_200_at_entry": ema_200_value,
            "alignment_200ema": alignment,
            "confirmation_type": confirmation_type,
            "is_in_news_window": bool(is_in_news),
            "consec_above_entry": 0,
            "consec_below_entry": 0,
            "entry_features": dict(entry_features) if entry_features else None,
        }

        self.daily_trade_counts[sast_date_str] = current_daily_count + 1
        self.open_positions.append(position)
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

            if direction == "BUY":
                pos["mfe_price"] = max(pos["mfe_price"], c_high)
                pos["mae_price"] = min(pos["mae_price"], c_low)
                if c_high > entry and not pos["loss_seen"]:
                    pos["profit_first"] = True
                if c_high > entry:
                    pos["profit_seen"] = True
                if c_low < entry:
                    pos["loss_seen"] = True
                if c_close > entry:
                    pos["consec_above_entry"] = pos.get("consec_above_entry", 0) + 1
                else:
                    pos["consec_above_entry"] = 0
            else:
                pos["mfe_price"] = min(pos["mfe_price"], c_low)
                pos["mae_price"] = max(pos["mae_price"], c_high)
                if c_low < entry and not pos["loss_seen"]:
                    pos["profit_first"] = True
                if c_low < entry:
                    pos["profit_seen"] = True
                if c_high > entry:
                    pos["loss_seen"] = True
                if c_close < entry:
                    pos["consec_below_entry"] = pos.get("consec_below_entry", 0) + 1
                else:
                    pos["consec_below_entry"] = 0

            sl_hit = (c_low <= sl) if direction == "BUY" else (c_high >= sl)
            tp_hit = (c_high >= tp) if direction == "BUY" else (c_low <= tp)

            if sl_hit and tp_hit:
                self._close_position(pos, sl, curr_time, "SL_CONSERVATIVE_COLLISION")
                continue

            if sl_hit:
                self._close_position(pos, sl, curr_time, "SL")
                continue

            if tp_hit:
                self._close_position(pos, tp, curr_time, "TP")
                continue

            if GLOBAL_PARAMS.use_breakeven and not pos["is_be_moved"]:
                progress = (c_close - entry) if direction == "BUY" else (entry - c_close)
                target_dist = abs(tp - entry)
                progress_met = (
                    target_dist > 0
                    and (progress / target_dist) >= 0.80
                    and progress >= (0.50 * sl_dist)
                )

                if self.be_mode == "STRUCTURAL":
                    structural_break = (
                        pos.get("consec_above_entry", 0) >= 2
                        if direction == "BUY"
                        else pos.get("consec_below_entry", 0) >= 2
                    )
                else:
                    structural_break = True

                if progress_met and structural_break:
                    pos["stop_loss"] = entry
                    pos["is_be_moved"] = True

            if GLOBAL_PARAMS.use_supertrend_trail and len(m5_slice) >= 15:
                exited = False
                if pos["trail_mode"] == "SUPERTREND":
                    st = calculate_supertrend(m5_slice, period=10, factor=1.6)
                    curr_dir = int(st['supertrend_direction'].iloc[-1])
                    if (direction == "BUY" and curr_dir == -1) or (direction == "SELL" and curr_dir == 1):
                        self._close_position(pos, c_close, curr_time, "SUPERTREND_TRAIL")
                        exited = True
                elif pos["trail_mode"] == "EMA_9":
                    if 'ema_9' in m5_slice.columns:
                        curr_ema = float(m5_slice['ema_9'].iloc[-1])
                    else:
                        curr_ema = float(m5_slice['close'].ewm(span=9, adjust=False).mean().iloc[-1])
                    if (direction == "BUY" and c_close < curr_ema) or (direction == "SELL" and c_close > curr_ema):
                        self._close_position(pos, c_close, curr_time, "EMA9_TRAIL")
                        exited = True
                elif pos["trail_mode"] == "EMA_25":
                    if 'ema_25' in m5_slice.columns:
                        curr_ema = float(m5_slice['ema_25'].iloc[-1])
                    else:
                        curr_ema = float(m5_slice['close'].ewm(span=25, adjust=False).mean().iloc[-1])
                    if (direction == "BUY" and c_close < curr_ema) or (direction == "SELL" and c_close > curr_ema):
                        self._close_position(pos, c_close, curr_time, "EMA25_TRAIL")
                        exited = True

                if exited:
                    continue

            if sast_time >= pos["eod_deadline_sast"]:
                self._close_position(pos, c_close, curr_time, "EOD_LOCKDOWN")
                continue

            remaining_positions.append(pos)

        self.open_positions = remaining_positions

        active_pending = []
        for pending in self.pending_sl_evaluations:
            if pending["symbol"] != symbol:
                active_pending.append(pending)
                continue

            if curr_time == pending["created_candle_time"]:
                active_pending.append(pending)
                continue

            direction = pending["direction"]
            kind = pending.get("kind", "SL")
            pending["candles_since_exit"] = pending.get("candles_since_exit", 0) + 1

            if kind == "SL":
                if direction == "BUY":
                    pending["min_low_after_exit"] = min(pending.get("min_low_after_exit", c_low), c_low)
                else:
                    pending["max_high_after_exit"] = max(pending.get("max_high_after_exit", c_high), c_high)

                target_tp = pending["target_tp"]
                cap_price = pending["cap_price"]

                reached_tp = (c_high >= target_tp) if direction == "BUY" else (c_low <= target_tp)
                if reached_tp:
                    pending["reached_original_tp"] = True
                    pending["candles_to_recovery"] = pending["candles_since_exit"]
                    pending["record"]["recovered_to_tp"] = True
                    self._finalize_post_exit(pending)
                    continue

                cap_hit = (c_low <= cap_price) if direction == "BUY" else (c_high >= cap_price)
                if cap_hit:
                    pending["cap_hit"] = True
                    self._finalize_post_exit(pending)
                    continue

                active_pending.append(pending)

            elif kind == "TP":
                if direction == "BUY":
                    pending["max_favorable_after_tp"] = max(
                        pending.get("max_favorable_after_tp", c_high), c_high
                    )
                else:
                    pending["min_favorable_after_tp"] = min(
                        pending.get("min_favorable_after_tp", c_low), c_low
                    )

                entry_price = pending["entry_price"]
                cap_price = pending["cap_price"]

                invalid = (c_low <= entry_price) if direction == "BUY" else (c_high >= entry_price)
                if invalid:
                    pending["invalid"] = True
                    self._finalize_post_exit(pending)
                    continue

                cap_hit = (c_high >= cap_price) if direction == "BUY" else (c_low <= cap_price)
                if cap_hit:
                    pending["cap_hit"] = True
                    self._finalize_post_exit(pending)
                    continue

                active_pending.append(pending)

        self.pending_sl_evaluations = active_pending

    def _finalize_post_exit(self, pending: Dict[str, Any]) -> None:
        record = pending["record"]
        kind = pending.get("kind", "SL")
        exit_price = pending["exit_price"]
        pip_size = pending["pip_size"]
        direction = pending["direction"]

        if kind == "SL":
            if direction == "BUY":
                worst = pending.get("min_low_after_exit", exit_price)
                max_pips = max(0.0, (exit_price - worst) / pip_size) if pip_size > 0 else 0.0
            else:
                worst = pending.get("max_high_after_exit", exit_price)
                max_pips = max(0.0, (worst - exit_price) / pip_size) if pip_size > 0 else 0.0

            sl_pips = pending.get("sl_pips", 0.0)
            record["post_sl_max_pips"] = round(max_pips, 1)
            record["post_sl_max_ratio"] = round((max_pips / sl_pips), 2) if sl_pips > 0 else 0.0
            record["post_sl_recovered"] = bool(pending.get("reached_original_tp", False))
            record["post_sl_candles"] = int(pending.get("candles_to_recovery", 0))

            record["post_sl_cont_pips"] = round(max_pips, 1)
            if not pending.get("reached_original_tp", False):
                record["recovered_to_tp"] = False

            original_tp = pending.get("target_tp", 0.0)
            is_be = bool(pending.get("is_be_moved", False))
            reached_tp = bool(pending.get("reached_original_tp", False))

            if is_be and reached_tp and original_tp > 0:
                entry = record.get("entry_price", 0.0)
                tp_dist = abs(original_tp - entry)
                sl_dist = record.get("initial_sl_dist") or tp_dist
                if sl_dist > 0:
                    missed_r = tp_dist / sl_dist
                else:
                    missed_r = 0.0
                record["premature_be_exit"] = True
                record["missed_r_at_tp"] = round(missed_r, 2)
            else:
                record["premature_be_exit"] = False
                record["missed_r_at_tp"] = 0.0

        elif kind == "TP":
            if direction == "BUY":
                best = pending.get("max_favorable_after_tp", exit_price)
                max_pips = max(0.0, (best - exit_price) / pip_size) if pip_size > 0 else 0.0
            else:
                best = pending.get("min_favorable_after_tp", exit_price)
                max_pips = max(0.0, (exit_price - best) / pip_size) if pip_size > 0 else 0.0

            tp_pips = pending.get("tp_pips", 0.0)
            record["post_tp_max_pips"] = round(max_pips, 1)
            record["post_tp_max_ratio"] = round((max_pips / tp_pips), 2) if tp_pips > 0 else 0.0
            record["post_tp_invalid"] = bool(pending.get("invalid", False))

            record["post_tp_extra_pips"] = round(max_pips, 1)

    def close_all(self, symbol: str, last_candle: pd.Series):
        c_close = float(last_candle['close'])
        curr_time = pd.to_datetime(last_candle['time'], utc=True).to_pydatetime()

        remaining_positions = []
        for pos in self.open_positions:
            if pos["symbol"] == symbol:
                self._close_position(pos, c_close, curr_time, "END_OF_DATA")
            else:
                remaining_positions.append(pos)
        self.open_positions = remaining_positions

        for pending in self.pending_sl_evaluations:
            self._finalize_post_exit(pending)
        self.pending_sl_evaluations = []

    def _replay_alt_targets(self, record: Dict[str, Any]) -> None:
        """
        PROPOSED: writes the four alt_r_* fields and the alt_timeout flag.
        Uses record["entry_epoch"] (an int) set by _close_position, so no
        string parsing and no timezone conversion happens here.
        """
        for k in ALT_TARGET_KEYS:
            record[k] = None
        record[ALT_TIMEOUT_FLAG_KEY] = False

        if self._m5_epochs is None or self._m5_epochs.size == 0:
            return

        try:
            entry = float(record["entry_price"])
            sl = float(record["sl"])
            direction = str(record["direction"]).upper()
            spread_pts = float(record.get("spread_paid", 0.0) or 0.0)
            entry_epoch = int(record.get("entry_epoch", 0))
        except Exception:
            return

        if entry_epoch <= 0:
            return

        sl_dist = abs(entry - sl)
        if sl_dist <= 0:
            return

        sign = 1.0 if direction == "BUY" else -1.0

        start = int(np.searchsorted(self._m5_epochs, entry_epoch, side="right"))
        if start >= self._m5_epochs.size:
            return

        end = min(self._m5_epochs.size, start + ALT_MAX_HOLD_CANDLES)
        highs = self._m5_highs[start:end]
        lows = self._m5_lows[start:end]
        closes = self._m5_closes[start:end]
        if highs.size == 0:
            return

        if direction == "BUY":
            sh = np.where(lows <= sl)[0]
        else:
            sh = np.where(highs >= sl)[0]
        stop_hit_idx = int(sh[0]) if sh.size > 0 else None

        for key, mult in zip(ALT_TARGET_KEYS, (1.0, 1.5, 2.0, 3.0)):
            target = entry + sign * mult * sl_dist

            if direction == "BUY":
                th = np.where(highs >= target)[0]
            else:
                th = np.where(lows <= target)[0]
            tgt_hit_idx = int(th[0]) if th.size > 0 else None

            if stop_hit_idx is not None and tgt_hit_idx is not None:
                exit_raw = sl if stop_hit_idx <= tgt_hit_idx else target
            elif stop_hit_idx is not None:
                exit_raw = sl
            elif tgt_hit_idx is not None:
                exit_raw = target
            else:
                exit_raw = float(closes[-1]) if closes.size > 0 else entry

            if direction == "BUY":
                actual_exit = exit_raw - (spread_pts / 2.0)
            else:
                actual_exit = exit_raw + (spread_pts / 2.0)

            price_diff = (actual_exit - entry) if direction == "BUY" else (entry - actual_exit)
            record[key] = round(price_diff / sl_dist, 2)

        timeout = (stop_hit_idx is None)
        if timeout:
            if direction == "BUY":
                th3 = np.where(highs >= (entry + 3.0 * sl_dist))[0]
            else:
                th3 = np.where(lows <= (entry - 3.0 * sl_dist))[0]
            if th3.size > 0:
                timeout = False
        record[ALT_TIMEOUT_FLAG_KEY] = bool(timeout)

    def _close_position(self, pos: Dict[str, Any], exit_price: float, exit_time: datetime, reason: str):
        direction = pos["direction"]
        entry = pos["entry_price"]
        sl_dist = pos["initial_sl_dist"]
        lots = pos["lots"]
        contract_size = pos["contract_size"]
        pip_size = pos.get("pip_size", 0.01)
        spread_pts = pos.get("spread_pts", 0.0)

        actual_exit = (exit_price - (spread_pts / 2.0)) if direction == "BUY" else (exit_price + (spread_pts / 2.0))

        if pos["symbol"] == "USDJPY":
            fx_exit = (1.0 / actual_exit) if actual_exit > 0 else 1.0
        elif pos["symbol"] == "GERMAN30":
            rate = self._get_eurusd_rate_at_or_before(exit_time)
            fx_exit = rate if (rate is not None and rate > 0) else 1.0
        else:
            fx_exit = 1.0

        price_diff = (actual_exit - entry) if direction == "BUY" else (entry - actual_exit)
        r_multiple = round(price_diff / sl_dist, 2) if sl_dist > 0 else 0.0
        money_pnl = round(price_diff * lots * contract_size * fx_exit, 2)

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

        if r_multiple > 0.1:
            result = "WIN"
        elif r_multiple < -0.1:
            result = "LOSS"
        else:
            result = "BREAKEVEN"

        duration_min = int((exit_time - pos["open_time"]).total_seconds() / 60)

        target_dist = abs(pos["take_profit"] - entry)
        if result == "WIN":
            failure_reason = "NONE_WIN"
        elif target_dist > 0 and (mfe_dist / target_dist) >= 0.75:
            failure_reason = "NEAR_TP_REVERSAL"
        elif mfe_r < 0.25:
            failure_reason = "STRAIGHT_DRAWDOWN"
        else:
            failure_reason = "CLEAN_LOSS"

        sast_date = pos["open_time"].astimezone(TZ_SAST).strftime("%Y-%m-%d")

        record = {
            "trade_id": pos["trade_id"],
            "date": pos["open_time"].strftime("%Y-%m-%d"),
            "date_sast": sast_date,
            "symbol": pos["symbol"],
            "strategy": pos["strategy"],
            "direction": direction,
            "signal_time_utc": pos["open_time"].strftime("%Y-%m-%d %H:%M:%S"),
            "signal_time_sast": pos["open_time"].astimezone(TZ_SAST).strftime("%Y-%m-%d %H:%M:%S"),
            "entry_epoch": int(pos.get("entry_epoch", 0)),
            "entry_price": round(entry, 5),
            "exit_price": round(actual_exit, 5),
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
            "spread_paid": spread_pts,
            "adr": pos["adr_val"],
            "regime": pos["regime"],
            "is_be_moved": bool(pos.get("is_be_moved", False)),
            "ema_200_at_entry": pos.get("ema_200_at_entry"),
            "alignment_200ema": pos.get("alignment_200ema", "UNKNOWN"),
            "confirmation_type": pos.get("confirmation_type", "CLOSE"),
            "is_in_news_window": bool(pos.get("is_in_news_window", False)),
            "post_sl_cont_pips": None,
            "post_tp_extra_pips": None,
            "premature_be_exit": False,
            "missed_r_at_tp": 0.0,
            "post_sl_max_pips": None,
            "post_sl_max_ratio": None,
            "post_sl_recovered": False,
            "post_sl_candles": 0,
            "post_tp_max_pips": None,
            "post_tp_max_ratio": None,
            "post_tp_invalid": False,
        }

        _RESERVED = {
            "trade_id", "date", "date_sast", "symbol", "strategy", "direction",
            "signal_time_utc", "signal_time_sast", "entry_epoch",
            "entry_price", "exit_price", "sl", "tp", "lots",
            "exit_time", "exit_reason", "duration_minutes",
            "result", "r_multiple", "money_pnl",
        }
        feats = pos.get("entry_features")
        if isinstance(feats, dict):
            for k, v in feats.items():
                if k in _RESERVED:
                    continue
                record[k] = v

        # Alt-target replay runs first so the four fields exist before
        # the post-exit tracker potentially rewrites other fields.
        self._replay_alt_targets(record)

        if result == "LOSS" and "SL" in reason:
            sl_pips = (sl_dist / pip_size) if pip_size > 0 else 0.0
            cap_past_sl = POST_SL_CAP_MULTIPLE * sl_dist
            if direction == "BUY":
                cap_price = actual_exit - cap_past_sl
            else:
                cap_price = actual_exit + cap_past_sl
            self.pending_sl_evaluations.append({
                "kind": "SL",
                "record": record,
                "symbol": pos["symbol"],
                "direction": direction,
                "target_tp": pos["take_profit"],
                "cap_price": cap_price,
                "sl_pips": sl_pips,
                "pip_size": pip_size,
                "exit_price": actual_exit,
                "is_be_moved": bool(pos.get("is_be_moved", False)),
                "created_candle_time": exit_time,
                "min_low_after_exit": actual_exit,
                "max_high_after_exit": actual_exit,
                "reached_original_tp": False,
                "cap_hit": False,
                "candles_since_exit": 0,
                "candles_to_recovery": 0,
            })

        elif result == "WIN" and reason == "TP":
            entry_price = pos["entry_price"]
            tp_dist = abs(pos["take_profit"] - entry_price)
            tp_pips = (tp_dist / pip_size) if pip_size > 0 else 0.0
            cap_past_tp = POST_TP_CAP_MULTIPLE * tp_dist
            if direction == "BUY":
                cap_price = pos["take_profit"] + cap_past_tp
            else:
                cap_price = pos["take_profit"] - cap_past_tp
            self.pending_sl_evaluations.append({
                "kind": "TP",
                "record": record,
                "symbol": pos["symbol"],
                "direction": direction,
                "entry_price": entry_price,
                "cap_price": cap_price,
                "tp_pips": tp_pips,
                "pip_size": pip_size,
                "exit_price": actual_exit,
                "created_candle_time": exit_time,
                "max_favorable_after_tp": actual_exit,
                "min_favorable_after_tp": actual_exit,
                "cap_hit": False,
                "invalid": False,
                "candles_since_exit": 0,
            })

        self.balance += money_pnl
        self.equity = self.balance
        self.completed_trades.append(record)
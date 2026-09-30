"""
trading-portal/risk/risk_manager.py
Institutional Unified Risk Engine with Real-Time Multi-Period Drawdown Throttling & Cashflow Adjustments.
Single Source of Truth for risk evaluation, micro-account tier sizing, and circuit breakers.
"""

import os
import json
import logging
import math
import pandas as pd
import numpy as np
from datetime import datetime, timezone, timedelta, time as dtime
from typing import Dict, Tuple, Optional, Any

try:
    from config.strategy_params import GLOBAL_PARAMS
    from core.session_config import TZ_SAST
except ImportError:
    import sys
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
    from core.session_config import GLOBAL_PARAMS, TZ_SAST

log = logging.getLogger("RiskManager")

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
RISK_STATE_FILE = os.getenv("RISK_STATE_FILE", os.path.join(PROJECT_ROOT, "risk_state.json"))


def get_sast_session_date() -> str:
    """Calculates active session date strictly aligned with the SAST reset hour."""
    now_sast = datetime.now(timezone.utc).astimezone(TZ_SAST)
    reset_hour = getattr(GLOBAL_PARAMS, 'daily_reset_hour_sast', 0)
    if now_sast.hour < reset_hour:
        now_sast -= timedelta(days=1)
    return now_sast.strftime("%Y-%m-%d")


class RiskManager:
    def __init__(self, config_file: str = "bot_config.json", state_file: str = RISK_STATE_FILE):
        self.config_file = config_file if os.path.isabs(config_file) else os.path.join(PROJECT_ROOT, config_file)
        self.state_file = state_file

        # UI & Spec Synced Controls (with bulletproof getattr fallbacks)
        self.master_execution: bool = True
        self.dry_run: bool = False
        self.risk_per_trade_pct: float = getattr(GLOBAL_PARAMS, 'base_risk_per_trade_pct', 1.0)
        self.risk_to_reward: float = 2.0
        self.max_daily_trades: int = getattr(GLOBAL_PARAMS, 'max_daily_trades', 2)
        self.max_daily_loss_pct: float = getattr(GLOBAL_PARAMS, 'max_daily_loss_pct', 5.0)
        self.max_weekly_loss_pct: float = getattr(GLOBAL_PARAMS, 'max_weekly_loss_pct', 10.0)
        self.max_monthly_loss_pct: float = getattr(GLOBAL_PARAMS, 'max_monthly_loss_pct', 15.0)

        # USD Drawdown Limits default to 0.0 (Unset -> Percentage limits act as active fallback)
        self.max_daily_loss_usd: float = getattr(GLOBAL_PARAMS, 'max_daily_loss_usd', 0.0)
        self.max_weekly_loss_usd: float = getattr(GLOBAL_PARAMS, 'max_weekly_loss_usd', 0.0)
        self.max_monthly_loss_usd: float = getattr(GLOBAL_PARAMS, 'max_monthly_loss_usd', 0.0)

        # Currency Switch Tracking
        self.last_seen_currency: Optional[str] = None
        self.currency_tripped_at: Optional[str] = None

        # Circuit Breaker State (HALT_PREVENT_NEW default)
        self.breaker_action: str = 'HALT_PREVENT_NEW'
        self.breaker_triggered: bool = False
        self.breaker_halted_master: bool = False
        self.active_trip_scope: str = 'NONE'
        self.last_trigger_reason: Optional[str] = None

        # Operational State (Strict SAST Calendar Boundaries)
        self.current_day_str: str = get_sast_session_date()
        self.current_week_str: str = datetime.now(timezone.utc).astimezone(TZ_SAST).strftime("%Y-W%W")
        self.current_month_str: str = datetime.now(timezone.utc).astimezone(TZ_SAST).strftime("%Y-%m")

        self.starting_day_equity: float = 0.0
        self.starting_week_equity: float = 0.0
        self.starting_month_equity: float = 0.0

        # Cashflow Ledger (Distinguishes trade PnL from deposits/withdrawals)
        self.last_known_balance: float = 0.0
        self.expected_balance: float = 0.0

        self.trades_taken_today: int = 0
        self.consecutive_losses: int = 0
        self.current_daily_loss: float = 0.0
        self.current_weekly_loss: float = 0.0
        self.current_monthly_loss: float = 0.0
        self.open_positions: Dict[str, dict] = {}

        self.sync_ui_config()
        self.load_persistent_state()

    def sync_ui_config(self) -> None:
        """Pulls authoritative settings from bot_config.json."""
        if not os.path.exists(self.config_file):
            return
        try:
            with open(self.config_file, "r") as f:
                cfg = json.load(f)

            self.master_execution = cfg.get("masterExecution", self.master_execution)
            self.dry_run = cfg.get("dryRun", self.dry_run)
            self.risk_per_trade_pct = float(cfg.get("riskPerTradePct", self.risk_per_trade_pct))
            self.risk_to_reward = float(cfg.get("riskToReward", self.risk_to_reward))

            if "maxDailyTrades" in cfg:
                self.max_daily_trades = int(cfg["maxDailyTrades"])

            # USD limits take precedence if > 0.0; otherwise 0.0 enables percentage fallback
            if "maxDailyLossUsd" in cfg:
                self.max_daily_loss_usd = float(cfg["maxDailyLossUsd"])
            elif "maxDailyLoss" in cfg:
                self.max_daily_loss_usd = float(cfg["maxDailyLoss"])

            if "maxWeeklyLossUsd" in cfg:
                self.max_weekly_loss_usd = float(cfg["maxWeeklyLossUsd"])
            elif "maxWeeklyLoss" in cfg:
                self.max_weekly_loss_usd = float(cfg["maxWeeklyLoss"])

            if "maxMonthlyLossUsd" in cfg:
                self.max_monthly_loss_usd = float(cfg["maxMonthlyLossUsd"])
            elif "maxMonthlyLoss" in cfg:
                self.max_monthly_loss_usd = float(cfg["maxMonthlyLoss"])

            self.breaker_action = cfg.get("breakerAction", self.breaker_action)

            # Clear CURRENCY trip if limits were confirmed by user in UI
            limits_confirmed_at = cfg.get("limitsConfirmedAt")
            if self.active_trip_scope == 'CURRENCY' and self.breaker_triggered and limits_confirmed_at:
                if not self.currency_tripped_at or limits_confirmed_at >= self.currency_tripped_at:
                    self.breaker_triggered = False
                    self.active_trip_scope = 'NONE'
                    self.last_trigger_reason = None
                    self.master_execution = True
                    self.breaker_halted_master = False
                    self.save_persistent_state()
                    log.info("CURRENCY BREAKER CLEARED: New risk limits confirmed by user in UI.")
        except Exception as e:
            log.warning(f"Could not sync config from {self.config_file}: {e}")

    def load_persistent_state(self):
        """Zero-Amnesia: Restores multi-period counters and streak tracking from risk_state.json."""
        if not os.path.exists(self.state_file):
            return
        try:
            with open(self.state_file, "r") as f:
                st = json.load(f)

            self.consecutive_losses = st.get("consecutive_losses", 0)
            self.current_week_str = st.get("current_week_str", self.current_week_str)
            self.current_month_str = st.get("current_month_str", self.current_month_str)
            self.starting_week_equity = st.get("starting_week_equity", 0.0)
            self.starting_month_equity = st.get("starting_month_equity", 0.0)
            self.current_weekly_loss = st.get("current_weekly_loss", 0.0)
            self.current_monthly_loss = st.get("current_monthly_loss", 0.0)
            self.last_seen_currency = st.get("last_seen_currency")
            self.currency_tripped_at = st.get("currency_tripped_at")
            self.breaker_triggered = st.get("breaker_triggered", False)
            self.breaker_halted_master = st.get("breaker_halted_master", False)
            self.active_trip_scope = st.get("active_trip_scope", "NONE")
            self.last_known_balance = st.get("last_known_balance", 0.0)
            self.expected_balance = st.get("expected_balance", self.last_known_balance)

            saved_day = st.get("current_day_str")
            now_day = get_sast_session_date()

            if saved_day == now_day:
                self.current_day_str = saved_day
                self.trades_taken_today = st.get("trades_taken_today", 0)
                self.current_daily_loss = st.get("current_daily_loss", 0.0)
                self.starting_day_equity = st.get("starting_day_equity", 0.0)
            else:
                self.current_day_str = now_day
                self.trades_taken_today = 0
                self.current_daily_loss = 0.0
                if self.active_trip_scope == 'DAY':
                    self.breaker_triggered = False
                    self.active_trip_scope = 'NONE'
                    if self.breaker_halted_master:
                        self.master_execution = True
                        self.breaker_halted_master = False
                    log.info("AUTO RE-ARM: Daily circuit breaker cleared on day rollover.")
        except Exception as e:
            log.warning(f"Could not load risk state: {e}")

    def check_currency_change(self, current_currency: Optional[str]):
        """Trips HALT_PREVENT_NEW on currency switch; never triggers on first run or identical currency."""
        if not current_currency:
            return
        if self.last_seen_currency is not None and self.last_seen_currency != current_currency:
            trip_msg = f"Account currency changed ({self.last_seen_currency} -> {current_currency}). Confirm risk limits in UI to resume."
            self.currency_tripped_at = datetime.now(timezone.utc).isoformat()
            self._trip_breaker('CURRENCY', trip_msg)
        self.last_seen_currency = current_currency
        self.save_persistent_state()

    def save_persistent_state(self):
        """Persists authoritative risk state strictly to risk_state.json."""
        try:
            st = {
                "current_day_str": self.current_day_str,
                "current_week_str": self.current_week_str,
                "current_month_str": self.current_month_str,
                "trades_taken_today": self.trades_taken_today,
                "consecutive_losses": self.consecutive_losses,
                "current_daily_loss": self.current_daily_loss,
                "current_weekly_loss": self.current_weekly_loss,
                "current_monthly_loss": self.current_monthly_loss,
                "starting_day_equity": self.starting_day_equity,
                "starting_week_equity": self.starting_week_equity,
                "starting_month_equity": self.starting_month_equity,
                "last_known_balance": self.last_known_balance,
                "expected_balance": self.expected_balance,
                "last_seen_currency": self.last_seen_currency,
                "currency_tripped_at": self.currency_tripped_at,
                "breaker_triggered": self.breaker_triggered,
                "breaker_halted_master": self.breaker_halted_master,
                "active_trip_scope": self.active_trip_scope,
                "last_trigger_reason": self.last_trigger_reason,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }
            with open(self.state_file, "w") as f:
                json.dump(st, f, indent=2)
        except Exception as e:
            log.error(f"Failed to persist risk state: {e}")

    def check_rollovers(self, current_equity: float, current_balance: float = 0.0):
        """
        Multi-Period Rollover & Cashflow Reconciliation:
        - Daily reset at 00:00 SAST.
        - Weekly reset on Monday 00:00 SAST.
        - Monthly reset on 1st of month.
        - Reconciles deposits/withdrawals without polluting trade PnL.
        """
        now_day = get_sast_session_date()
        now_sast = datetime.now(timezone.utc).astimezone(TZ_SAST)
        now_week = now_sast.strftime("%Y-W%W")
        now_month = now_sast.strftime("%Y-%m")

        # 1. Cashflow Ledger: Reconcile external deposits/withdrawals
        if current_balance > 0:
            if self.last_known_balance == 0.0:
                self.last_known_balance = current_balance
                self.expected_balance = current_balance
            else:
                inferred_cashflow = current_balance - self.expected_balance
                noise_threshold = max(2.0, 0.002 * current_balance)

                if abs(inferred_cashflow) > noise_threshold:
                    self.starting_day_equity = max(0.0, self.starting_day_equity + inferred_cashflow)
                    self.starting_week_equity = max(0.0, self.starting_week_equity + inferred_cashflow)
                    self.starting_month_equity = max(0.0, self.starting_month_equity + inferred_cashflow)
                    log.info(f"EXTERNAL CASHFLOW RECONCILED: {inferred_cashflow:+.2f} adjusted across period baselines.")
                    self.expected_balance = current_balance

            self.last_known_balance = current_balance

        # 2. Daily Rollover & Auto Re-arm
        if now_day != self.current_day_str:
            self.current_day_str = now_day
            self.trades_taken_today = 0
            self.current_daily_loss = 0.0
            if current_equity > 0:
                self.starting_day_equity = current_equity
            if self.active_trip_scope == 'DAY':
                self.breaker_triggered = False
                self.active_trip_scope = 'NONE'
                if self.breaker_halted_master:
                    self.master_execution = True
                    self.breaker_halted_master = False
                log.info("AUTO RE-ARM: Daily circuit breaker cleared for new SAST session.")
            log.info(f"DAILY RISK RESET: Session date {now_day} initialized.")

        # 3. Weekly Rollover (Monday 00:00 SAST)
        if now_week != self.current_week_str:
            self.current_week_str = now_week
            self.current_weekly_loss = 0.0
            if current_equity > 0:
                self.starting_week_equity = current_equity
            if self.active_trip_scope == 'WEEK':
                self.breaker_triggered = False
                self.active_trip_scope = 'NONE'
                if self.breaker_halted_master:
                    self.master_execution = True
                    self.breaker_halted_master = False
                log.info("AUTO RE-ARM: Weekly circuit breaker cleared for new trading week.")
            log.info(f"WEEKLY RISK RESET: Week {now_week} initialized.")

        # 4. Monthly Rollover (1st of Month)
        if now_month != self.current_month_str:
            self.current_month_str = now_month
            self.current_monthly_loss = 0.0
            if current_equity > 0:
                self.starting_month_equity = current_equity
            if self.active_trip_scope == 'MONTH':
                self.breaker_triggered = False
                self.active_trip_scope = 'NONE'
                if self.breaker_halted_master:
                    self.master_execution = True
                    self.breaker_halted_master = False
                log.info("AUTO RE-ARM: Monthly circuit breaker cleared for new calendar month.")
            log.info(f"MONTHLY RISK RESET: Month {now_month} initialized.")

        # Baseline initialization on cold start
        if current_equity > 0:
            if self.starting_day_equity <= 0: self.starting_day_equity = current_equity
            if self.starting_week_equity <= 0: self.starting_week_equity = current_equity
            if self.starting_month_equity <= 0: self.starting_month_equity = current_equity

        self.save_persistent_state()

    def record_trade_outcome(self, pnl: float):
        """Updates trade count, streak tracking, and expected balance ledger with NET realized P&L."""
        self.expected_balance += pnl
        if pnl < 0:
            self.consecutive_losses += 1
            self.current_daily_loss += abs(pnl)
            self.current_weekly_loss += abs(pnl)
            self.current_monthly_loss += abs(pnl)
            log.warning(f"LOSS RECORDED (-${abs(pnl):.2f}). Consecutive loss streak: {self.consecutive_losses}")
        elif pnl > 0:
            self.consecutive_losses = 0
            log.info(f"WIN RECORDED (+${pnl:.2f}). Consecutive loss streak reset.")
        self.save_persistent_state()

    def combined_risk_pct(self, current_equity: float, dow_mult: float = 1.0, ai_factor: float = 1.0) -> float:
        """
        Single Authority for Risk Percentage Sizing:
        - Micro-account mode tiers (<$60 at 25%, $60-$200 at 12.5%, $200-$1000 at 5%, >$1000 at 1%).
        - Bypasses 2.0% cap under micro-account mode.
        - Clamps UI risk to max_risk_per_trade_pct when micro mode is False.
        - Multiplies streak reduction (0.5x on 3+ losses), DOW multiplier, and AI factor.
        - Floored at min_risk_multiplier_floor (25% of base risk).
        """
        micro_mode = getattr(GLOBAL_PARAMS, 'micro_account_mode', False)
        if micro_mode:
            # Micro-account tiers bypass the 2.0% max_risk_per_trade_pct ceiling
            if current_equity < 60.0:
                base_risk = getattr(GLOBAL_PARAMS, 'micro_account_risk_pct', 25.0)
            elif 60.0 <= current_equity < 200.0:
                base_risk = 12.5
            elif 200.0 <= current_equity < 1000.0:
                base_risk = 5.0
            else:
                base_risk = 1.0
        else:
            base_risk = self.risk_per_trade_pct
            max_ceiling = getattr(GLOBAL_PARAMS, 'max_risk_per_trade_pct', 2.0)
            if base_risk > max_ceiling:
                log.warning(
                    f"UI Risk ({base_risk}%) exceeds safety ceiling ({max_ceiling}%). "
                    f"Clamping base risk to {max_ceiling}%."
                )
                base_risk = max_ceiling

        loss_threshold = getattr(GLOBAL_PARAMS, 'consecutive_loss_threshold', 3)
        streak_mult = 0.5 if self.consecutive_losses >= loss_threshold else 1.0
        raw_mult = streak_mult * dow_mult * ai_factor
        mult_floor = getattr(GLOBAL_PARAMS, 'min_risk_multiplier_floor', 0.25)
        final_mult = max(raw_mult, mult_floor)
        return base_risk * final_mult

    def validate_min_lot_risk(self, min_lots: float, risk_per_lot: float, risk_cash: float) -> Tuple[bool, str]:
        """
        Rejects trade if broker minimum lot risk exceeds 1.5x allowable cash risk.
        Protects small accounts from over-leveraging when structural stops are wide.
        """
        min_lot_cash_risk = min_lots * risk_per_lot
        tolerance = getattr(GLOBAL_PARAMS, 'min_lot_risk_tolerance', 1.5)
        allowed_max = tolerance * risk_cash
        if min_lot_cash_risk > allowed_max:
            msg = (
                f"Min-Lot Risk Rejection: Minimum trade size ({min_lots:.2f} lots) "
                f"risks ${min_lot_cash_risk:.2f}, exceeding 1.5x allowable risk budget (${allowed_max:.2f})."
            )
            log.warning(msg)
            return False, msg
        return True, "Min lot risk within tolerance"

    def can_trade_today(self, current_equity: float, current_balance: float = 0.0) -> Tuple[bool, str]:
        """
        Evaluates multi-period drawdown thresholds against live mark-to-market equity.
        Directly invoked by validate_pre_trade before dispatching any order.
        """
        self.sync_ui_config()
        self.check_rollovers(current_equity, current_balance)

        if not self.master_execution or self.breaker_triggered:
            return False, f"Circuit Breaker Armed [{self.active_trip_scope}]: {self.last_trigger_reason or 'Trading halted by risk policy'}"

        if self.trades_taken_today >= self.max_daily_trades:
            return False, f"Daily trade limit reached ({self.trades_taken_today}/{self.max_daily_trades})"

        # 1. Daily Drawdown Evaluation (USD limit prioritized over % limit)
        daily_dd_usd = max(0.0, self.starting_day_equity - current_equity) if self.starting_day_equity > 0 else self.current_daily_loss
        max_daily_usd = self.max_daily_loss_usd if self.max_daily_loss_usd > 0 else (self.starting_day_equity * (self.max_daily_loss_pct / 100.0))
        if daily_dd_usd >= max_daily_usd and max_daily_usd > 0:
            self._trip_breaker('DAY', f"Daily Drawdown Ceiling breached (-${daily_dd_usd:.2f} >= ${max_daily_usd:.2f})")
            return False, self.last_trigger_reason

        # 2. Weekly Drawdown Evaluation
        weekly_dd_usd = max(0.0, self.starting_week_equity - current_equity) if self.starting_week_equity > 0 else self.current_weekly_loss
        max_weekly_usd = self.max_weekly_loss_usd if self.max_weekly_loss_usd > 0 else (self.starting_week_equity * (self.max_weekly_loss_pct / 100.0))
        if weekly_dd_usd >= max_weekly_usd and max_weekly_usd > 0:
            self._trip_breaker('WEEK', f"Weekly Drawdown Ceiling breached (-${weekly_dd_usd:.2f} >= ${max_weekly_usd:.2f})")
            return False, self.last_trigger_reason

        # 3. Monthly Drawdown Evaluation
        monthly_dd_usd = max(0.0, self.starting_month_equity - current_equity) if self.starting_month_equity > 0 else self.current_monthly_loss
        max_monthly_usd = self.max_monthly_loss_usd if self.max_monthly_loss_usd > 0 else (self.starting_month_equity * (self.max_monthly_loss_pct / 100.0))
        if monthly_dd_usd >= max_monthly_usd and max_monthly_usd > 0:
            self._trip_breaker('MONTH', f"Monthly Drawdown Ceiling breached (-${monthly_dd_usd:.2f} >= ${max_monthly_usd:.2f})")
            return False, self.last_trigger_reason

        return True, "Risk gates clear"

    def validate_asset_stop_size(self, symbol: str, sl_distance: float) -> Tuple[bool, str]:
        """Legacy fixed stop boundary validator (used when adaptive_mode is False)."""
        if symbol == "NAS100":
            if not (GLOBAL_PARAMS.nas100_stop_range[0] <= sl_distance <= GLOBAL_PARAMS.nas100_stop_range[2]):
                return False, f"NAS100 Stop ({sl_distance:.1f} pts) outside spec [35-60 pts]"
        elif symbol == "US30":
            if not (GLOBAL_PARAMS.us30_stop_range[0] <= sl_distance <= GLOBAL_PARAMS.us30_stop_range[2]):
                return False, f"US30 Stop ({sl_distance:.1f} pts) outside spec [30-50 pts]"
        elif symbol == "GOLD":
            pips = sl_distance * 10.0
            if not (GLOBAL_PARAMS.gold_stop_range_pips[0] <= pips <= GLOBAL_PARAMS.gold_stop_range_pips[2]):
                return False, f"Gold Stop ({pips:.1f} pips) outside spec [12-60 pips]"
        return True, "Stop size valid"

    def _trip_breaker(self, scope: str, reason: str):
        """Engages circuit breaker, sets state, and halts order flow."""
        self.breaker_triggered = True
        self.active_trip_scope = scope
        self.last_trigger_reason = reason
        self.breaker_halted_master = True
        self.master_execution = False
        log.critical(f"CIRCUIT BREAKER ENGAGED [{scope}]: {reason}. Action: HALT_PREVENT_NEW")
        self.save_persistent_state()


# Backwards compatibility aliases
RiskState = RiskManager
InstitutionalRiskEngine = RiskManager
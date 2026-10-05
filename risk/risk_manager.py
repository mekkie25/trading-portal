"""
trading-portal/risk/risk_manager.py
Institutional Unified Risk Engine with Real-Time Multi-Period Drawdown Throttling & Cashflow Adjustments.
Single Source of Truth for risk evaluation, risk profiles, micro-account tier sizing, and circuit breakers.
"""

import os
import json
import logging
import math
import tempfile
import pandas as pd
import numpy as np
from datetime import datetime, timezone, timedelta, time as dtime
from typing import Dict, Tuple, Optional, Any, List

try:
    from config.strategy_params import GLOBAL_PARAMS
    from core.session_config import TZ_SAST
except ImportError:
    import sys
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
    from core.session_config import GLOBAL_PARAMS, TZ_SAST

log = logging.getLogger("RiskManager")

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

# Support unified DATA_DIR persistent storage volume
DATA_DIR = os.getenv("DATA_DIR", "").strip() or PROJECT_ROOT
os.makedirs(DATA_DIR, exist_ok=True)
RISK_STATE_FILE = os.getenv("RISK_STATE_FILE", os.path.join(DATA_DIR, "risk_state.json"))


# ==============================================================================
# PROPOSED: INSTITUTIONAL RISK PROFILES SPECIFICATION
# ==============================================================================
# Bands in ZAR: <500, 500-2k, 2k-10k, 10k-50k, >50k
# PROPOSED (Gap 1): weekly_loss_stop_pct and monthly_loss_stop_pct per profile
#   so the weekly breaker cannot trip before the daily stop makes sense.
RISK_PROFILES: Dict[str, Dict[str, Any]] = {
    "Steady": {
        "bands_zar": [500.0, 2000.0, 10000.0, 50000.0],
        "risk_pct_by_band": [5.0, 3.0, 2.0, 1.5, 1.0],
        "daily_loss_stop_pct": 5.0,
        "weekly_loss_stop_pct": 10.0,
        "monthly_loss_stop_pct": 15.0,
        "min_rr_floor": 1.0,
        "max_daily_trades": 2,
    },
    "Balanced": {
        "bands_zar": [500.0, 2000.0, 10000.0, 50000.0],
        "risk_pct_by_band": [10.0, 6.0, 4.0, 3.0, 2.0],
        "daily_loss_stop_pct": 15.0,
        "weekly_loss_stop_pct": 25.0,
        "monthly_loss_stop_pct": 40.0,
        "min_rr_floor": 1.5,
        "max_daily_trades": 3,
    },
    "Aggressive": {
        "bands_zar": [500.0, 2000.0, 10000.0, 50000.0],
        "risk_pct_by_band": [30.0, 15.0, 8.0, 5.0, 3.0],
        "daily_loss_stop_pct": 30.0,
        "weekly_loss_stop_pct": 50.0,
        "monthly_loss_stop_pct": 70.0,
        "min_rr_floor": 2.0,
        "max_daily_trades": 4,
    },
    "Max Growth": {
        "bands_zar": [500.0, 2000.0, 10000.0, 50000.0],
        "risk_pct_by_band": [35.0, 25.0, 12.0, 6.0, 4.0],  # PROPOSED: 35% cap under R500
        "daily_loss_stop_pct": 50.0,
        "weekly_loss_stop_pct": 70.0,
        "monthly_loss_stop_pct": 85.0,
        "min_rr_floor": 2.0,
        "max_daily_trades": 4,
    },
}


def get_sast_session_date() -> str:
    """Calculates active session date strictly aligned with the SAST reset hour."""
    now_sast = datetime.now(timezone.utc).astimezone(TZ_SAST)
    reset_hour = getattr(GLOBAL_PARAMS, 'daily_reset_hour_sast', 0)
    if now_sast.hour < reset_hour:
        now_sast -= timedelta(days=1)
    return now_sast.strftime("%Y-%m-%d")


def convert_equity_to_zar(current_equity: float, account_currency: Optional[str] = "USD", usd_zar_rate: Optional[float] = None) -> float:
    """
    PROPOSED: Converts equity into ZAR equivalent for profile account-size bands.
    Uses provided live usd_zar_rate, or fallback rate of 18.0 if unquoted.
    """
    curr = (account_currency or "USD").upper()
    if curr == "ZAR":
        return current_equity

    rate = usd_zar_rate if (usd_zar_rate is not None and usd_zar_rate > 0) else 18.0
    if curr == "USD":
        return current_equity * rate
    elif curr == "EUR":
        return current_equity * 1.10 * rate
    elif curr == "GBP":
        return current_equity * 1.30 * rate
    return current_equity * rate


class RiskManager:
    def __init__(self, config_file: str = "bot_config.json", state_file: str = RISK_STATE_FILE):
        self.config_file = config_file if os.path.isabs(config_file) else os.path.join(DATA_DIR, config_file)
        self.state_file = state_file

        # Active Profile state (None = Default Legacy Behavior)
        self.active_profile_name: Optional[str] = None
        self.active_profile: Optional[Dict[str, Any]] = None

        # UI & Spec Synced Controls
        self.master_execution: bool = True
        self.dry_run: bool = False
        self.risk_per_trade_pct: float = getattr(GLOBAL_PARAMS, 'base_risk_per_trade_pct', 1.0)
        self.risk_to_reward: float = 2.0
        self.max_daily_trades: int = getattr(GLOBAL_PARAMS, 'max_daily_trades', 2)
        self.max_daily_loss_pct: float = getattr(GLOBAL_PARAMS, 'max_daily_loss_pct', 5.0)
        self.max_weekly_loss_pct: float = getattr(GLOBAL_PARAMS, 'max_weekly_loss_pct', 10.0)
        self.max_monthly_loss_pct: float = getattr(GLOBAL_PARAMS, 'max_monthly_loss_pct', 15.0)
        self.min_rr_floor: float = getattr(GLOBAL_PARAMS, 'min_rr', 1.0)

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

        # Cashflow & Profit Ledger
        self.last_known_balance: float = 0.0
        self.expected_balance: float = 0.0
        self.today_closed_profit: float = 0.0  # Tracks today's closed winnings for house money

        self.trades_taken_today: int = 0
        self.consecutive_losses: int = 0
        self.current_daily_loss: float = 0.0
        self.current_weekly_loss: float = 0.0
        self.current_monthly_loss: float = 0.0
        self.open_positions: Dict[str, dict] = {}

        self.sync_ui_config()
        self.load_persistent_state()

    def sync_ui_config(self) -> None:
        """Pulls authoritative settings from bot_config.json with safe JSON parsing."""
        if not os.path.exists(self.config_file):
            return
        try:
            with open(self.config_file, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if not content:
                    return
                cfg = json.loads(content)

            self.master_execution = cfg.get("masterExecution", self.master_execution)
            self.dry_run = cfg.get("dryRun", self.dry_run)
            self.risk_per_trade_pct = float(cfg.get("riskPerTradePct", self.risk_per_trade_pct))
            self.risk_to_reward = float(cfg.get("riskToReward", self.risk_to_reward))

            # PROPOSED: Read active risk profile (Steady, Balanced, Aggressive, Max Growth)
            prof_name = cfg.get("riskProfile")
            if prof_name in RISK_PROFILES:
                self.active_profile_name = prof_name
                self.active_profile = RISK_PROFILES[prof_name]
                self.max_daily_trades = self.active_profile["max_daily_trades"]
                self.max_daily_loss_pct = self.active_profile["daily_loss_stop_pct"]
                self.min_rr_floor = self.active_profile["min_rr_floor"]
                # PROPOSED (Gap 1): profile-scaled weekly/monthly caps
                self.max_weekly_loss_pct = self.active_profile["weekly_loss_stop_pct"]
                self.max_monthly_loss_pct = self.active_profile["monthly_loss_stop_pct"]
            else:
                self.active_profile_name = None
                self.active_profile = None
                # PROPOSED (Gap 1): restore legacy GLOBAL_PARAMS values when profile is unset
                self.max_daily_loss_pct = getattr(GLOBAL_PARAMS, 'max_daily_loss_pct', 5.0)
                self.max_weekly_loss_pct = getattr(GLOBAL_PARAMS, 'max_weekly_loss_pct', 10.0)
                self.max_monthly_loss_pct = getattr(GLOBAL_PARAMS, 'max_monthly_loss_pct', 15.0)
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
            with open(self.state_file, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if not content:
                    return
                st = json.loads(content)

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
            self.today_closed_profit = st.get("today_closed_profit", 0.0)

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
                self.today_closed_profit = 0.0
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
        """Persists authoritative risk state atomically using a temporary file and atomic replace."""
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
                "today_closed_profit": self.today_closed_profit,
                "last_seen_currency": self.last_seen_currency,
                "currency_tripped_at": self.currency_tripped_at,
                "breaker_triggered": self.breaker_triggered,
                "breaker_halted_master": self.breaker_halted_master,
                "active_trip_scope": self.active_trip_scope,
                "last_trigger_reason": self.last_trigger_reason,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }
            dirname = os.path.dirname(self.state_file)
            os.makedirs(dirname, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(dir=dirname, prefix="tmp_risk_state_", suffix=".json")
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(st, f, indent=2)
            os.replace(tmp_path, self.state_file)
        except Exception as e:
            log.error(f"Failed to persist risk state atomically: {e}")

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
            self.today_closed_profit = 0.0
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
            self.today_closed_profit += pnl  # PROPOSED: Accumulate today's closed winnings for house money
            log.info(f"WIN RECORDED (+${pnl:.2f}). Consecutive loss streak reset.")
        self.save_persistent_state()

    def _get_profile_band_risk_pct(self, profile: Dict[str, Any], zar_equity: float) -> float:
        """Helper returning the profile's risk percentage for the current ZAR equity band."""
        bands = profile["bands_zar"]
        risks = profile["risk_pct_by_band"]

        if zar_equity < bands[0]:
            return risks[0]
        elif bands[0] <= zar_equity < bands[1]:
            return risks[1]
        elif bands[1] <= zar_equity < bands[2]:
            return risks[2]
        elif bands[2] <= zar_equity < bands[3]:
            return risks[3]
        else:
            return risks[4]

    def combined_risk_pct(
        self,
        current_equity: float,
        dow_mult: float = 1.0,
        ai_factor: float = 1.0,
        account_currency: Optional[str] = "USD",
        usd_zar_rate: Optional[float] = None
    ) -> float:
        """
        PROPOSED: Dynamic Sizing Engine with Selectable Risk Profiles:
        - If NO profile set: Preserves exact current/legacy behavior.
        - If profile set:
          * Converts equity to ZAR equivalent via convert_equity_to_zar.
          * Sets base risk % from the profile band.
          * Halves risk after 2 consecutive losses.
          * AI multiplier is clamped to <= 1.0 (can only veto/lower, never raise).
          * House money: Extra risk cash may only use up to 50% of today's closed profit.
          * Single trade cash risk is capped by the remaining daily loss allowance.
        """
        # =====================================================================
        # 1. DEFAULT BEHAVIOR (When no profile is selected)
        # =====================================================================
        if self.active_profile is None:
            micro_mode = getattr(GLOBAL_PARAMS, 'micro_account_mode', False)
            if micro_mode:
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
                    base_risk = max_ceiling

            loss_threshold = getattr(GLOBAL_PARAMS, 'consecutive_loss_threshold', 3)
            streak_mult = 0.5 if self.consecutive_losses >= loss_threshold else 1.0
            raw_mult = streak_mult * dow_mult * ai_factor
            mult_floor = getattr(GLOBAL_PARAMS, 'min_risk_multiplier_floor', 0.25)
            final_mult = max(raw_mult, mult_floor)
            return base_risk * final_mult

        # =====================================================================
        # 2. SELECTABLE PROFILE BEHAVIOR (Steady, Balanced, Aggressive, Max Growth)
        # =====================================================================
        zar_equity = convert_equity_to_zar(current_equity, account_currency, usd_zar_rate)
        profile_band_risk = self._get_profile_band_risk_pct(self.active_profile, zar_equity)

        # Streak penalty: Halve after 2 consecutive losses
        streak_mult = 0.5 if self.consecutive_losses >= 2 else 1.0

        # AI Overseer Safety: Clamp to <= 1.0 (veto or lower only, never raise)
        safe_ai_factor = min(1.0, max(0.5, ai_factor))

        base_multiplier = streak_mult * dow_mult * safe_ai_factor
        effective_profile_risk = profile_band_risk * max(0.25, base_multiplier)

        # Calculate nominal risk in cash
        nominal_risk_cash = current_equity * (effective_profile_risk / 100.0)

        # House money bonus: Extra risk may use up to 50% of today's closed profit (never starting capital)
        if self.today_closed_profit > 0:
            house_money_allowance = 0.50 * self.today_closed_profit
            # Cap house money additions so risk never exceeds the profile's tier cap
            max_cash_cap = current_equity * (profile_band_risk / 100.0)
            nominal_risk_cash = min(max_cash_cap, nominal_risk_cash + house_money_allowance)

        # Circuit Breaker Safety: Single trade risk cannot exceed remaining daily allowance
        # PROPOSED: Fall back to current_equity when starting_day_equity is still 0 (cold start).
        effective_day_start = self.starting_day_equity if self.starting_day_equity > 0 else current_equity
        max_daily_usd = self.max_daily_loss_usd if self.max_daily_loss_usd > 0 else (
            effective_day_start * (self.active_profile["daily_loss_stop_pct"] / 100.0)
        )
        daily_dd_usd = max(0.0, effective_day_start - current_equity)
        remaining_daily_cash = max(0.0, max_daily_usd - daily_dd_usd)

        if remaining_daily_cash > 0:
            final_risk_cash = min(nominal_risk_cash, remaining_daily_cash)
        else:
            final_risk_cash = 0.0

        final_pct = (final_risk_cash / current_equity) * 100.0 if current_equity > 0 else 0.0
        return max(0.0, final_pct)

    def get_sizing_snapshot(
        self,
        current_equity: float,
        account_currency: Optional[str] = None,
        usd_zar_rate: Optional[float] = None
    ) -> Dict[str, Any]:
        """
        PROPOSED: Read-only snapshot of current sizing state for logging / UI.
        Does not change any state. Safe to call every scan.
        """
        curr = (account_currency or "USD").upper()

        if self.active_profile is not None:
            zar_eq = convert_equity_to_zar(current_equity, curr, usd_zar_rate)
            cap_pct = self._get_profile_band_risk_pct(self.active_profile, zar_eq)
            profile_label = self.active_profile_name
        else:
            cap_pct = self.risk_per_trade_pct
            profile_label = "None (Legacy)"

        try:
            chosen_pct = self.combined_risk_pct(
                current_equity=current_equity,
                account_currency=curr,
                usd_zar_rate=usd_zar_rate,
            )
        except Exception:
            chosen_pct = 0.0

        # Daily loss budget
        # PROPOSED: Fall back to current_equity when starting_day_equity is still 0 (cold start).
        effective_day_start = self.starting_day_equity if self.starting_day_equity > 0 else current_equity
        if self.max_daily_loss_usd > 0:
            daily_max = self.max_daily_loss_usd
        elif self.active_profile is not None:
            daily_max = effective_day_start * (self.active_profile["daily_loss_stop_pct"] / 100.0)
        else:
            daily_max = effective_day_start * (self.max_daily_loss_pct / 100.0)

        daily_used = max(0.0, effective_day_start - current_equity)
        daily_left = max(0.0, daily_max - daily_used)

        return {
            "profile": profile_label,
            "cap_pct": round(cap_pct, 3),
            "chosen_pct": round(chosen_pct, 3),
            "daily_max": round(daily_max, 4),
            "daily_used": round(daily_used, 4),
            "daily_left": round(daily_left, 4),
            "trades_today": self.trades_taken_today,
            "max_daily_trades": self.max_daily_trades,
            "currency": curr,
        }

    def validate_min_lot_risk(self, min_lots: float, risk_per_lot: float, risk_cash: float) -> Tuple[bool, str]:
        """
        Rejects trade if broker minimum lot risk exceeds allowable cash risk.
        In Aggressive / Max Growth on tiny accounts, allows a small tolerance (1.5x) for high-conviction entries.
        """
        min_lot_cash_risk = min_lots * risk_per_lot
        if self.active_profile_name in ("Aggressive", "Max Growth"):
            tolerance = 1.5
        else:
            tolerance = getattr(GLOBAL_PARAMS, 'min_lot_risk_tolerance', 1.2)

        allowed_max = tolerance * risk_cash
        if min_lot_cash_risk > allowed_max:
            msg = (
                f"Min-Lot Risk Rejection: Minimum trade size ({min_lots:.2f} lots) "
                f"risks ${min_lot_cash_risk:.2f}, exceeding allowed budget (${allowed_max:.2f})."
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

        # Daily Drawdown Evaluation
        # PROPOSED (Gap 1): profile-scaled daily %, weekly %, monthly % are all set in sync_ui_config.
        daily_loss_pct = self.active_profile["daily_loss_stop_pct"] if self.active_profile else self.max_daily_loss_pct
        daily_dd_usd = max(0.0, self.starting_day_equity - current_equity) if self.starting_day_equity > 0 else self.current_daily_loss
        max_daily_usd = self.max_daily_loss_usd if self.max_daily_loss_usd > 0 else (self.starting_day_equity * (daily_loss_pct / 100.0))

        if daily_dd_usd >= max_daily_usd and max_daily_usd > 0:
            self._trip_breaker('DAY', f"Daily Drawdown Ceiling breached (-${daily_dd_usd:.2f} >= ${max_daily_usd:.2f})")
            return False, self.last_trigger_reason

        # Weekly Drawdown Evaluation
        weekly_dd_usd = max(0.0, self.starting_week_equity - current_equity) if self.starting_week_equity > 0 else self.current_weekly_loss
        max_weekly_usd = self.max_weekly_loss_usd if self.max_weekly_loss_usd > 0 else (self.starting_week_equity * (self.max_weekly_loss_pct / 100.0))
        if weekly_dd_usd >= max_weekly_usd and max_weekly_usd > 0:
            self._trip_breaker('WEEK', f"Weekly Drawdown Ceiling breached (-${weekly_dd_usd:.2f} >= ${max_weekly_usd:.2f})")
            return False, self.last_trigger_reason

        # Monthly Drawdown Evaluation
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
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

DATA_DIR = os.getenv("DATA_DIR", "").strip() or PROJECT_ROOT
os.makedirs(DATA_DIR, exist_ok=True)
RISK_STATE_FILE = os.getenv("RISK_STATE_FILE", os.path.join(DATA_DIR, "risk_state.json"))
# PROPOSED: path to the journal so we can rebuild live counters at startup.
TRADES_DB_FILE = os.path.join(DATA_DIR, "trades_db.json")


# ==============================================================================
# PROPOSED: INSTITUTIONAL RISK PROFILES SPECIFICATION
# ==============================================================================
RISK_PROFILES: Dict[str, Dict[str, Any]] = {
    "Steady": {
        "bands_zar": [500.0, 2000.0, 10000.0, 50000.0],
        "risk_pct_by_band": [5.0, 3.0, 2.0, 1.5, 1.0],
        "daily_loss_stop_pct": 5.0,
        "weekly_loss_stop_pct": 10.0,
        "monthly_loss_stop_pct": 15.0,
        "min_rr_floor": 1.0,
        "max_daily_trades": 2,
        "apply_dow_reduction": True,
    },
    "Balanced": {
        "bands_zar": [500.0, 2000.0, 10000.0, 50000.0],
        "risk_pct_by_band": [10.0, 6.0, 4.0, 3.0, 2.0],
        "daily_loss_stop_pct": 15.0,
        "weekly_loss_stop_pct": 25.0,
        "monthly_loss_stop_pct": 40.0,
        "min_rr_floor": 1.5,
        "max_daily_trades": 3,
        "apply_dow_reduction": True,
    },
    "Aggressive": {
        "bands_zar": [500.0, 2000.0, 10000.0, 50000.0],
        "risk_pct_by_band": [30.0, 15.0, 8.0, 5.0, 3.0],
        "daily_loss_stop_pct": 30.0,
        "weekly_loss_stop_pct": 50.0,
        "monthly_loss_stop_pct": 70.0,
        "min_rr_floor": 2.0,
        "max_daily_trades": 4,
        "apply_dow_reduction": False,
    },
    "Max Growth": {
        "bands_zar": [500.0, 2000.0, 10000.0, 50000.0],
        "risk_pct_by_band": [35.0, 25.0, 12.0, 6.0, 4.0],
        "daily_loss_stop_pct": 50.0,
        "weekly_loss_stop_pct": 70.0,
        "monthly_loss_stop_pct": 85.0,
        "min_rr_floor": 2.0,
        "max_daily_trades": 4,
        "apply_dow_reduction": False,
    },
}


def get_sast_session_date() -> str:
    now_sast = datetime.now(timezone.utc).astimezone(TZ_SAST)
    reset_hour = getattr(GLOBAL_PARAMS, 'daily_reset_hour_sast', 0)
    if now_sast.hour < reset_hour:
        now_sast -= timedelta(days=1)
    return now_sast.strftime("%Y-%m-%d")


def convert_equity_to_zar(current_equity: float, account_currency: Optional[str] = "USD", usd_zar_rate: Optional[float] = None) -> float:
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

        self.active_profile_name: Optional[str] = None
        self.active_profile: Optional[Dict[str, Any]] = None

        self.master_execution: bool = True
        self.dry_run: bool = False
        self.risk_per_trade_pct: float = getattr(GLOBAL_PARAMS, 'base_risk_per_trade_pct', 1.0)
        self.risk_to_reward: float = 2.0
        self.max_daily_trades: int = getattr(GLOBAL_PARAMS, 'max_daily_trades', 2)
        self.max_daily_loss_pct: float = getattr(GLOBAL_PARAMS, 'max_daily_loss_pct', 5.0)
        self.max_weekly_loss_pct: float = getattr(GLOBAL_PARAMS, 'max_weekly_loss_pct', 10.0)
        self.max_monthly_loss_pct: float = getattr(GLOBAL_PARAMS, 'max_monthly_loss_pct', 15.0)
        self.min_rr_floor: float = getattr(GLOBAL_PARAMS, 'min_rr', 1.0)

        # PROPOSED (Gap 2): switch controlling USD vs profile % precedence
        self.use_profile_drawdown_pct: bool = True

        self.max_daily_loss_usd: float = getattr(GLOBAL_PARAMS, 'max_daily_loss_usd', 0.0)
        self.max_weekly_loss_usd: float = getattr(GLOBAL_PARAMS, 'max_weekly_loss_usd', 0.0)
        self.max_monthly_loss_usd: float = getattr(GLOBAL_PARAMS, 'max_monthly_loss_usd', 0.0)

        self.last_seen_currency: Optional[str] = None
        self.currency_tripped_at: Optional[str] = None

        self.breaker_action: str = 'HALT_PREVENT_NEW'
        self.breaker_triggered: bool = False
        self.breaker_halted_master: bool = False
        self.active_trip_scope: str = 'NONE'
        self.last_trigger_reason: Optional[str] = None

        self.current_day_str: str = get_sast_session_date()
        self.current_week_str: str = datetime.now(timezone.utc).astimezone(TZ_SAST).strftime("%Y-W%W")
        self.current_month_str: str = datetime.now(timezone.utc).astimezone(TZ_SAST).strftime("%Y-%m")

        self.starting_day_equity: float = 0.0
        self.starting_week_equity: float = 0.0
        self.starting_month_equity: float = 0.0

        self.last_known_balance: float = 0.0
        self.expected_balance: float = 0.0
        self.today_closed_profit: float = 0.0

        self.trades_taken_today: int = 0
        self.consecutive_losses: int = 0
        self.current_daily_loss: float = 0.0
        self.current_weekly_loss: float = 0.0
        self.current_monthly_loss: float = 0.0
        self.open_positions: Dict[str, dict] = {}

        # PROPOSED (Step 1 of deal-replay fix): record the process start time.
        # record_trade_outcome_scoped uses this as a hard gate so replayed
        # historical deals never touch live risk state.
        self._bot_started_at_utc: datetime = datetime.now(timezone.utc)

        # PROPOSED (Option A): read bot_config.json once at construction so a
        # freshly built RiskManager already has the active risk profile,
        # min R:R, USD limits and master_execution flag. No-op if the file
        # does not exist. Live sizing already called sync_ui_config() before
        # every trade, so this does not change live behaviour — it only makes
        # the object's state match what the first scan would have set anyway.
        self.sync_ui_config()

        # PROPOSED (Step 1 of deal-replay fix): rebuild day/week/month loss
        # counters from the journal once at startup. Fired from __init__
        # because load_persistent_state() is not called anywhere in this repo.
        self.rebuild_period_counters_from_history()

    def sync_ui_config(self) -> None:
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

            prof_name = cfg.get("riskProfile")
            profile_is_active = prof_name in RISK_PROFILES

            if profile_is_active:
                self.active_profile_name = prof_name
                self.active_profile = RISK_PROFILES[prof_name]
                self.max_daily_trades = self.active_profile["max_daily_trades"]
                self.max_daily_loss_pct = self.active_profile["daily_loss_stop_pct"]
                self.min_rr_floor = self.active_profile["min_rr_floor"]
                self.max_weekly_loss_pct = self.active_profile["weekly_loss_stop_pct"]
                self.max_monthly_loss_pct = self.active_profile["monthly_loss_stop_pct"]
            else:
                self.active_profile_name = None
                self.active_profile = None
                self.max_daily_loss_pct = getattr(GLOBAL_PARAMS, 'max_daily_loss_pct', 5.0)
                self.max_weekly_loss_pct = getattr(GLOBAL_PARAMS, 'max_weekly_loss_pct', 10.0)
                self.max_monthly_loss_pct = getattr(GLOBAL_PARAMS, 'max_monthly_loss_pct', 15.0)
                if "maxDailyTrades" in cfg:
                    self.max_daily_trades = int(cfg["maxDailyTrades"])

            # PROPOSED (Gap 2): Read switch. Default True.
            use_profile_pct = bool(cfg.get("useProfileDrawdownPct", True))
            self.use_profile_drawdown_pct = use_profile_pct

            raw_daily_usd = 0.0
            if "maxDailyLossUsd" in cfg:
                raw_daily_usd = float(cfg["maxDailyLossUsd"])
            elif "maxDailyLoss" in cfg:
                raw_daily_usd = float(cfg["maxDailyLoss"])

            raw_weekly_usd = 0.0
            if "maxWeeklyLossUsd" in cfg:
                raw_weekly_usd = float(cfg["maxWeeklyLossUsd"])
            elif "maxWeeklyLoss" in cfg:
                raw_weekly_usd = float(cfg["maxWeeklyLoss"])

            raw_monthly_usd = 0.0
            if "maxMonthlyLossUsd" in cfg:
                raw_monthly_usd = float(cfg["maxMonthlyLossUsd"])
            elif "maxMonthlyLoss" in cfg:
                raw_monthly_usd = float(cfg["maxMonthlyLoss"])

            # PROPOSED (Gap 2): precedence rule.
            if profile_is_active and use_profile_pct:
                self.max_daily_loss_usd = 0.0
                self.max_weekly_loss_usd = 0.0
                self.max_monthly_loss_usd = 0.0
            else:
                self.max_daily_loss_usd = raw_daily_usd
                self.max_weekly_loss_usd = raw_weekly_usd
                self.max_monthly_loss_usd = raw_monthly_usd

            self.breaker_action = cfg.get("breakerAction", self.breaker_action)

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
        if not current_currency:
            return
        if self.last_seen_currency is not None and self.last_seen_currency != current_currency:
            trip_msg = f"Account currency changed ({self.last_seen_currency} -> {current_currency}). Confirm risk limits in UI to resume."
            self.currency_tripped_at = datetime.now(timezone.utc).isoformat()
            self._trip_breaker('CURRENCY', trip_msg)
        self.last_seen_currency = current_currency
        self.save_persistent_state()

    def save_persistent_state(self):
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
        now_day = get_sast_session_date()
        now_sast = datetime.now(timezone.utc).astimezone(TZ_SAST)
        now_week = now_sast.strftime("%Y-W%W")
        now_month = now_sast.strftime("%Y-%m")

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

        if current_equity > 0:
            if self.starting_day_equity <= 0: self.starting_day_equity = current_equity
            if self.starting_week_equity <= 0: self.starting_week_equity = current_equity
            if self.starting_month_equity <= 0: self.starting_month_equity = current_equity

        self.save_persistent_state()

    def record_trade_outcome(self, pnl: float):
        self.expected_balance += pnl
        if pnl < 0:
            self.consecutive_losses += 1
            self.current_daily_loss += abs(pnl)
            self.current_weekly_loss += abs(pnl)
            self.current_monthly_loss += abs(pnl)
            log.warning(f"LOSS RECORDED (-${abs(pnl):.2f}). Consecutive loss streak: {self.consecutive_losses}")
        elif pnl > 0:
            self.consecutive_losses = 0
            self.today_closed_profit += pnl
            log.info(f"WIN RECORDED (+${pnl:.2f}). Consecutive loss streak reset.")
        self.save_persistent_state()

    def record_trade_outcome_scoped(self, pnl: float, closed_at_utc: Optional[datetime]) -> bool:
        """
        PROPOSED (Step 1 of deal-replay fix).

        Scoped variant used only by the deal-replay sync path.

        Hard rule: this method changes NOTHING -- no daily/weekly/monthly
        loss, no today_closed_profit, no consecutive_losses, no
        expected_balance -- unless the deal closed AFTER self._bot_started_at_utc.
        Deals that closed earlier go to trades_db.json only.

        Returns True only if it changed state.
        """
        if closed_at_utc is None:
            return False

        if closed_at_utc.tzinfo is None:
            closed_at_utc = closed_at_utc.replace(tzinfo=timezone.utc)

        startup = getattr(self, "_bot_started_at_utc", None)
        if startup is None:
            return False

        if startup.tzinfo is None:
            startup = startup.replace(tzinfo=timezone.utc)

        if closed_at_utc < startup:
            return False

        close_sast = closed_at_utc.astimezone(TZ_SAST)
        today_str = get_sast_session_date()
        week_str = close_sast.strftime("%Y-W%W")
        month_str = close_sast.strftime("%Y-%m")

        touched = False

        if pnl < 0:
            if close_sast.strftime("%Y-%m-%d") == today_str:
                self.current_daily_loss += abs(pnl)
                touched = True
            if week_str == self.current_week_str:
                self.current_weekly_loss += abs(pnl)
                touched = True
            if month_str == self.current_month_str:
                self.current_monthly_loss += abs(pnl)
                touched = True
            self.consecutive_losses += 1
            touched = True
        elif pnl > 0:
            if close_sast.strftime("%Y-%m-%d") == today_str:
                self.today_closed_profit += pnl
                touched = True
            self.consecutive_losses = 0
            touched = True
        else:
            return False

        if touched:
            self.expected_balance += pnl
            self.save_persistent_state()

        return touched

    def rebuild_period_counters_from_history(self) -> None:
        """
        PROPOSED (Step 1 of deal-replay fix).

        Rebuilds current_daily_loss, current_weekly_loss, current_monthly_loss
        and today_closed_profit from trades_db.json at process startup.

        Only deals whose close time (stored in UTC as "YYYY-MM-DD HH:MM:SS")
        falls inside the current SAST day / week / month are counted. Duplicate
                tickets are counted once. Missing or empty file -> counters are set
        to zero. Corrupt (non-list) JSON -> log a warning, leave counters
        untouched.
        """
        try:
            if not os.path.exists(TRADES_DB_FILE):
                self.current_daily_loss = 0.0
                self.current_weekly_loss = 0.0
                self.current_monthly_loss = 0.0
                self.today_closed_profit = 0.0
                log.info("[RISK] rebuilt loss counters: day=0.00, week=0.00, month=0.00 (no trades_db.json)")
                return

            with open(TRADES_DB_FILE, "r", encoding="utf-8") as f:
                content = f.read().strip()

            if not content:
                self.current_daily_loss = 0.0
                self.current_weekly_loss = 0.0
                self.current_monthly_loss = 0.0
                self.today_closed_profit = 0.0
                log.info("[RISK] rebuilt loss counters: day=0.00, week=0.00, month=0.00 (empty trades_db.json)")
                return

            rows = json.loads(content)
            if not isinstance(rows, list):
                log.warning("[RISK] trades_db.json is not a JSON list; skipping counter rebuild.")
                return

            today_str = get_sast_session_date()
            day_loss = 0.0
            week_loss = 0.0
            month_loss = 0.0
            today_profit = 0.0
            seen_tickets: set = set()

            for row in rows:
                if not isinstance(row, dict):
                    continue

                ticket = str(row.get("ticket", "")).strip()
                if ticket:
                    if ticket in seen_tickets:
                        continue
                    seen_tickets.add(ticket)

                close_time_str = row.get("closeTime")
                if not close_time_str or close_time_str == "OPEN":
                    continue

                try:
                    close_dt = datetime.strptime(str(close_time_str), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                except (ValueError, TypeError):
                    continue

                close_sast = close_dt.astimezone(TZ_SAST)
                row_day = close_sast.strftime("%Y-%m-%d")
                row_week = close_sast.strftime("%Y-W%W")
                row_month = close_sast.strftime("%Y-%m")

                try:
                    pnl = float(row.get("pnl", 0.0) or 0.0)
                except (ValueError, TypeError):
                    pnl = 0.0

                if row_day == today_str:
                    if pnl < 0:
                        day_loss += abs(pnl)
                    elif pnl > 0:
                        today_profit += pnl
                if row_week == self.current_week_str and pnl < 0:
                    week_loss += abs(pnl)
                if row_month == self.current_month_str and pnl < 0:
                    month_loss += abs(pnl)

            self.current_daily_loss = round(day_loss, 4)
            self.current_weekly_loss = round(week_loss, 4)
            self.current_monthly_loss = round(month_loss, 4)
            self.today_closed_profit = round(today_profit, 4)

            log.info(
                f"[RISK] rebuilt loss counters: day={self.current_daily_loss:.2f}, "
                f"week={self.current_weekly_loss:.2f}, month={self.current_monthly_loss:.2f}"
            )
        except Exception as e:
            log.warning(f"[RISK] rebuild_period_counters_from_history failed: {e}")

    def _get_profile_band_risk_pct(self, profile: Dict[str, Any], zar_equity: float) -> float:
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
        # PROPOSED: Aggressive and Max Growth ignore the Monday/Friday halving.
        # Steady, Balanced and no-profile keep the existing day-of-week reduction.
        if self.active_profile is not None and not self.active_profile.get("apply_dow_reduction", True):
            dow_mult = 1.0

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

        zar_equity = convert_equity_to_zar(current_equity, account_currency, usd_zar_rate)
        profile_band_risk = self._get_profile_band_risk_pct(self.active_profile, zar_equity)

        streak_mult = 0.5 if self.consecutive_losses >= 2 else 1.0
        safe_ai_factor = min(1.0, max(0.5, ai_factor))

        base_multiplier = streak_mult * dow_mult * safe_ai_factor
        effective_profile_risk = profile_band_risk * max(0.25, base_multiplier)

        nominal_risk_cash = current_equity * (effective_profile_risk / 100.0)

        if self.today_closed_profit > 0:
            house_money_allowance = 0.50 * self.today_closed_profit
            max_cash_cap = current_equity * (profile_band_risk / 100.0)
            nominal_risk_cash = min(max_cash_cap, nominal_risk_cash + house_money_allowance)

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
        self.sync_ui_config()
        self.check_rollovers(current_equity, current_balance)

        if not self.master_execution or self.breaker_triggered:
            return False, f"Circuit Breaker Armed [{self.active_trip_scope}]: {self.last_trigger_reason or 'Trading halted by risk policy'}"

        if self.trades_taken_today >= self.max_daily_trades:
            return False, f"Daily trade limit reached ({self.trades_taken_today}/{self.max_daily_trades})"

        daily_loss_pct = self.active_profile["daily_loss_stop_pct"] if self.active_profile else self.max_daily_loss_pct
        daily_dd_usd = max(0.0, self.starting_day_equity - current_equity) if self.starting_day_equity > 0 else self.current_daily_loss
        max_daily_usd = self.max_daily_loss_usd if self.max_daily_loss_usd > 0 else (self.starting_day_equity * (daily_loss_pct / 100.0))

        if daily_dd_usd >= max_daily_usd and max_daily_usd > 0:
            self._trip_breaker('DAY', f"Daily Drawdown Ceiling breached (-${daily_dd_usd:.2f} >= ${max_daily_usd:.2f})")
            return False, self.last_trigger_reason

        weekly_dd_usd = max(0.0, self.starting_week_equity - current_equity) if self.starting_week_equity > 0 else self.current_weekly_loss
        max_weekly_usd = self.max_weekly_loss_usd if self.max_weekly_loss_usd > 0 else (self.starting_week_equity * (self.max_weekly_loss_pct / 100.0))
        if weekly_dd_usd >= max_weekly_usd and max_weekly_usd > 0:
            self._trip_breaker('WEEK', f"Weekly Drawdown Ceiling breached (-${weekly_dd_usd:.2f} >= ${max_weekly_usd:.2f})")
            return False, self.last_trigger_reason

        monthly_dd_usd = max(0.0, self.starting_month_equity - current_equity) if self.starting_month_equity > 0 else self.current_monthly_loss
        max_monthly_usd = self.max_monthly_loss_usd if self.max_monthly_loss_usd > 0 else (self.starting_month_equity * (self.max_monthly_loss_pct / 100.0))
        if monthly_dd_usd >= max_monthly_usd and max_monthly_usd > 0:
            self._trip_breaker('MONTH', f"Monthly Drawdown Ceiling breached (-${monthly_dd_usd:.2f} >= ${max_monthly_usd:.2f})")
            return False, self.last_trigger_reason

        return True, "Risk gates clear"

    def validate_asset_stop_size(self, symbol: str, sl_distance: float) -> Tuple[bool, str]:
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
        self.breaker_triggered = True
        self.active_trip_scope = scope
        self.last_trigger_reason = reason
        self.breaker_halted_master = True
        self.master_execution = False
        log.critical(f"CIRCUIT BREAKER ENGAGED [{scope}]: {reason}. Action: HALT_PREVENT_NEW")
        self.save_persistent_state()


RiskState = RiskManager
InstitutionalRiskEngine = RiskManager
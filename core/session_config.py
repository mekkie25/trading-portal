"""
trading-portal/core/session_config.py
Institutional Quantitative Strategy Parameters, Session Timing & DST Management.
Single Source of Truth for all quantitative parameters.
"""

import sys
import types
from datetime import datetime, timezone, time
from zoneinfo import ZoneInfo
from typing import Tuple, Dict, Any, List
from dataclasses import dataclass, field

# ==============================================================================
# 1. INSTITUTIONAL STRATEGY PARAMETERS (Spec Source of Truth)
# ==============================================================================

@dataclass
class StrategyParameters:
    # Feature Toggle: Volatility Engine
    adaptive_mode: bool = False                  # False = Legacy fixed bands; True = Adaptive ADR Engine
    target_rr: float = 1.0                       # Fixed risk-to-reward target multiplier
    use_breakeven: bool = False                  # Move stop to BE at 80% R:R if enabled

    # Risk & Execution Caps (Spec Section 5 & 7)
    base_risk_per_trade_pct: float = 1.0         # Baseline risk 1%
    max_risk_per_trade_pct: float = 2.0          # Hard risk ceiling: UI risk is clamped to this maximum
    consecutive_loss_threshold: int = 3          # 3 consecutive losses
    consecutive_loss_risk_pct: float = 0.5       # Scale down multiplier to 0.5x
    max_daily_trades: int = 2                    # Max 2 trades/day (1 London, 1 NY)
    max_daily_loss_pct: float = 5.0              # 5% max daily drawdown
    max_weekly_loss_pct: float = 10.0            # Dynamic weekly equity drawdown cap
    max_monthly_loss_pct: float = 15.0           # Dynamic monthly equity drawdown cap
    micro_account_mode: bool = False             # Small account safety switch
    micro_account_risk_pct: float = 25.0
    require_cvd_absorption: bool = False         # Relaxed: prevents tick-volume proxy over-rejection
    enable_sector_limit: bool = False
    ai_overseer_enabled: bool = False            # Spec Audit: AI disabled by default
    require_dxy_alignment: bool = True
    daily_reset_hour_sast: int = 0

    # Drawdown Currency Ceilings (Authoritative UI Defaults; Overridden by bot_config.json)
    max_daily_loss_usd: float = 0.0
    max_weekly_loss_usd: float = 0.0
    max_monthly_loss_usd: float = 0.0

    # Volatility Engine Parameters & Dynamic Ratios
    min_rr: float = 1.0                          # Minimum acceptable R:R on adapted target
    max_spread_to_sl_ratio: float = 0.30         # Maximum spread cost as fraction of SL
    min_risk_multiplier_floor: float = 0.25      # Combined risk multiplier cannot drop below 25% of UI risk
    min_lot_risk_tolerance: float = 1.5          # Reject if min lot risk > 1.5x allowable cash risk
    adr_sl_ratios: dict = field(default_factory=lambda: {
        "GOLD": (0.08, 0.20, 0.33),
        "NAS100": (0.15, 0.22, 0.28),
        "US30": (0.10, 0.15, 0.18),
        "GERMAN30": (0.12, 0.20, 0.25),
        "EURUSD": (0.15, 0.22, 0.30),
        "GBPUSD": (0.15, 0.22, 0.30),
        "USDJPY": (0.15, 0.22, 0.30),
    })

    # Asset-Specific Stop Size Parameters (Spec Section 5 Legacy Bands)
    nas100_stop_range: tuple = (35.0, 50.0, 60.0)
    us30_stop_range: tuple = (30.0, 50.0, 50.0)
    gold_stop_range_pips: tuple = (12.0, 40.0, 60.0)
    spy_stop_range: tuple = (4.0, 5.0, 5.0)

    # Session Windows & Opening Range (Spec Section 1 & 2)
    asia_start_sast: str = "01:00"
    asia_end_sast: str = "06:00"
    london_open_hour_local: int = 8
    ny_open_hour_local: int = 9
    ny_open_minute_local: int = 30
    opening_range_minutes: int = 15
    cracker_or_minutes: int = 5

    # Indicators & Profiles (Spec Section 2)
    value_area_pct: float = 0.75                 # True 75% Value Area
    supertrend_atr_period: int = 10
    supertrend_factor: float = 1.6
    ema_fast_9: int = 9
    ema_slow_25: int = 25
    ema_fast_5: int = 5
    ema_slow_13: int = 13
    ema_trend_200: int = 200

    # Day-of-Week Filters (Spec Section 1)
    skip_monday_trading: bool = False
    reduce_friday_risk: bool = True
    friday_risk_multiplier: float = 0.5

    # Strategy Specific Settings
    grubber_kick_fixed_sl: float = 35.0
    pdh_pdl_liquidity_buffer_pts: float = 15.0
    breakeven_trigger_ratio: float = 0.80

    # Blackout dates (YYYY-MM-DD HH:MM in UTC)
    news_blackout_schedule: List[str] = field(default_factory=lambda: [
        "2026-10-02 12:30",
        "2026-10-14 12:30",
        "2026-11-04 18:00",
    ])

GLOBAL_PARAMS = StrategyParameters()

# Virtual module alias so legacy "import config" resolves immediately
if 'config' not in sys.modules:
    _cfg = types.ModuleType('config')
    _sp = types.ModuleType('config.strategy_params')
    _sp.GLOBAL_PARAMS = GLOBAL_PARAMS
    _sp.StrategyParameters = StrategyParameters
    _cfg.strategy_params = _sp
    sys.modules['config'] = _cfg
    sys.modules['config.strategy_params'] = _sp

# ==============================================================================
# 2. CANONICAL TIMEZONES & MARKET SESSIONS
# ==============================================================================

TZ_SAST = ZoneInfo("Africa/Johannesburg")
TZ_LONDON = ZoneInfo("Europe/London")
TZ_NEWYORK = ZoneInfo("America/New_York")
TZ_UTC = ZoneInfo("UTC")

class MarketSessionManager:
    @staticmethod
    def get_current_times(dt_utc: datetime = None) -> Dict[str, datetime]:
        if dt_utc is None:
            dt_utc = datetime.now(timezone.utc)
        elif dt_utc.tzinfo is None:
            dt_utc = dt_utc.replace(tzinfo=timezone.utc)

        return {
            "UTC": dt_utc,
            "SAST": dt_utc.astimezone(TZ_SAST),
            "LONDON": dt_utc.astimezone(TZ_LONDON),
            "NEWYORK": dt_utc.astimezone(TZ_NEWYORK),
        }

    @classmethod
    def is_in_asia_session(cls, dt_utc: datetime = None) -> bool:
        times = cls.get_current_times(dt_utc)
        t_sast = times["SAST"].time()
        return time(1, 0) <= t_sast < time(6, 0)

    @classmethod
    def is_in_london_open(cls, dt_utc: datetime = None) -> bool:
        times = cls.get_current_times(dt_utc)
        t_london = times["LONDON"].time()
        return time(8, 0) <= t_london <= time(10, 0)

    @classmethod
    def is_in_london_fix(cls, dt_utc: datetime = None) -> bool:
        times = cls.get_current_times(dt_utc)
        t_london = times["LONDON"].time()
        return time(10, 25) <= t_london <= time(10, 45)

    @classmethod
    def is_in_ny_open(cls, dt_utc: datetime = None) -> bool:
        times = cls.get_current_times(dt_utc)
        t_ny = times["NEWYORK"].time()
        return time(9, 30) <= t_ny <= time(11, 0)

    @classmethod
    def is_in_ny_cracker_window(cls, dt_utc: datetime = None) -> bool:
        times = cls.get_current_times(dt_utc)
        t_ny = times["NEWYORK"].time()
        return time(9, 30) <= t_ny <= time(10, 30)

    @classmethod
    def is_post_asia_grubber_window(cls, dt_utc: datetime = None) -> bool:
        times = cls.get_current_times(dt_utc)
        t_sast = times["SAST"].time()
        return time(6, 0) <= t_sast < time(21, 0)

    @classmethod
    def is_blackout_active(cls, dt_utc: datetime = None, blackout_minutes: int = 15) -> Tuple[bool, str]:
        if dt_utc is None:
            dt_utc = datetime.now(timezone.utc)
        elif dt_utc.tzinfo is None:
            dt_utc = dt_utc.replace(tzinfo=timezone.utc)

        for ts_str in GLOBAL_PARAMS.news_blackout_schedule:
            try:
                target_dt = datetime.strptime(ts_str, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
                delta_sec = abs((dt_utc - target_dt).total_seconds())
                if delta_sec <= (blackout_minutes * 60):
                    return True, f"Scheduled Macro Blackout: {ts_str} UTC"
            except Exception:
                continue

        weekday = dt_utc.weekday()
        day = dt_utc.day
        hour = dt_utc.hour
        minute = dt_utc.minute

        # First Friday NFP (12:30 UTC window: 12:20 - 12:45)
        if weekday == 4 and day <= 7:
            if hour == 12 and 20 <= minute <= 45:
                return True, "NFP First-Friday Macro Blackout (12:30 UTC)"

        # Mid-month CPI (12:30 UTC window: 12:20 - 12:45)
        if 10 <= day <= 16 and weekday in (1, 2, 3, 4):
            if hour == 12 and 20 <= minute <= 45:
                return True, "US CPI Release Macro Blackout (12:30 UTC)"

        # Wednesday FOMC Rate Decision (18:00 UTC / 20:00 SAST)
        if weekday == 2 and ((hour == 17 and minute >= 50) or (hour == 18 and minute <= 20)):
            return True, "FOMC Interest Rate Decision Blackout (18:00 UTC)"

        return False, ""

    @classmethod
    def get_day_of_week_policy(cls, dt_utc: datetime = None) -> Tuple[bool, float, str]:
        times = cls.get_current_times(dt_utc)
        wd = times["SAST"].weekday()

        if wd == 0:
            if GLOBAL_PARAMS.skip_monday_trading:
                return False, 0.0, "Monday Trading Blocked via Policy"
            return True, 0.5, "Monday Low-Volume Caution (50% Size)"
        elif wd == 3:
            return True, 1.0, "Thursday Peak Statistical Edge (100% Size)"
        elif wd == 4:
            if GLOBAL_PARAMS.reduce_friday_risk:
                return True, GLOBAL_PARAMS.friday_risk_multiplier, "Friday Pullback Caution (Reduced Size)"
            return True, 1.0, "Friday Normal Trading"

        return True, 1.0, "Standard Session Day"
"""
trading-portal/core/session_config.py
Institutional Quantitative Strategy Parameters, Session Timing & DST Management.
Single Source of Truth for all quantitative parameters.

BRIEF CHANGES (2026-10-12):
- target_rr default raised from 1.0 to 2.5 (backtest parameter sweep §35 shows peak at >=2.5R on all pairs).
- New breakeven_trigger_r = 1.5 (BE is now a fixed R multiple, not 80% of TP).
- max_spread_in_r raised from 0.04 to 0.05 (brief item 3).
- trail_after_1r_enabled set to False (brief item 2: do not force BE at 1R).
- strat_always_htf_targets added for STRATEGY_513 and EMA_9_25_CROSS (brief item 6).
- blocked_hours_sast now includes 23 and 0 on every pair (rollover blackout, brief item 3).
- get_day_of_week_policy now halves risk on Monday AND Thursday (brief item 5).
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
    target_rr: float = 2.5                       # BRIEF: raised from 1.0 to 2.5
    use_breakeven: bool = False                  # Move stop to BE if enabled
    use_supertrend_trail: bool = True            # Dynamic SuperTrend trailing exit gate

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
    # BRIEF: Thursday now takes 0.5x alongside Monday. Friday is full risk.
    skip_monday_trading: bool = False
    reduce_friday_risk: bool = False             # retained for backwards compat; not used in policy
    friday_risk_multiplier: float = 1.0          # retained for backwards compat; not used in policy

    # Strategy Specific Settings
    grubber_kick_fixed_sl: float = 35.0
    pdh_pdl_liquidity_buffer_pts: float = 15.0

    # BRIEF: BE is now an absolute R multiple. 1.5R means BE fires after the
    # trade has banked 1.5x the stop distance in open profit.
    # breakeven_trigger_ratio is retained for backwards compat; it is no longer
    # read by the simulator or the live supervisor.
    breakeven_trigger_ratio: float = 0.80
    breakeven_trigger_r: float = 1.5

    # Blackout dates (YYYY-MM-DD HH:MM in UTC)
    news_blackout_schedule: List[str] = field(default_factory=lambda: [
        "2026-10-02 12:30",
        "2026-10-14 12:30",
        "2026-11-04 18:00",
    ])

    # ========================================================================
    # IMPROVEMENT PACK v1 + BRIEF ITEM 3 (ROLLOVER BLACKOUT)
    # Every pair blocks SAST hours 23 and 0 (Asian open / US rollover).
    # Additional per-pair hours come from §19 hour matrix.
    # ========================================================================
    blocked_hours_sast: Dict[str, List[int]] = field(default_factory=lambda: {
        "US30":     [0, 6, 7, 10, 11, 15, 23],
        "GOLD":     [0, 3, 6, 8, 10, 23],
        "NAS100":   [0, 4, 5, 13, 14, 23],
        "GERMAN30": [0, 9, 12, 13, 14, 23],
        "EURUSD":   [0, 2, 3, 8, 11, 13, 15, 23],
        "GBPUSD":   [0, 11, 14, 22, 23],
        "USDJPY":   [0, 3, 5, 13, 14, 23],
    })

    # Per-symbol weekday blackout (Mon=0 ... Sun=6).
    # NOTE: this is a HARD blacklist. The brief's Monday/Thursday risk
    # reduction is handled by get_day_of_week_policy, NOT by this list.
    blocked_weekdays: Dict[str, List[int]] = field(default_factory=lambda: {
        "US30":     [],
        "GOLD":     [],
        "NAS100":   [],
        "GERMAN30": [],
        "EURUSD":   [],
        "GBPUSD":   [],
        "USDJPY":   [],
    })

    # BRIEF item 3: spread ceiling raised from 0.04 to 0.05.
    max_spread_in_r: float = 0.05

    # Post-SL recovery compensation (§16).
    stop_distance_multiplier: float = 1.5

    # BRIEF item 2: trail-after-1R is disabled because it forced BE at 1R.
    # The dedicated breakeven_trigger_r now controls BE.
    trail_after_1r_enabled: bool = False

    # ========================================================================
    # BRIEF item 6: always-on HTF alignment filter.
    # These strategies must have their direction agree with the D1 trend
    # (last closed D1 close vs its 20-period EMA). Applies in both live and
    # backtest — see StrategyManager._apply_always_on_filters.
    # ========================================================================
    strat_always_htf_targets: List[str] = field(default_factory=lambda: [
        "STRATEGY_513",
        "EMA_9_25_CROSS",
    ])

    # --------------------------------------------------------------------------
    # Backtest-Only Strategy Filters (all default OFF; live behaviour unchanged)
    # Applied as post-filters in StrategyManager.evaluate_all, only for the
    # strategies listed in strat_filter_targets, and only when the runner
    # explicitly asks for them (apply_strat_filters=True).
    # --------------------------------------------------------------------------
    strat_filters_backtest_only: bool = True
    strat_filter_targets: List[str] = field(default_factory=lambda: [
        "STRATEGY_513",
        "AVWAP_200EMA_CONTINUATION",
    ])
    strat_disabled: List[str] = field(default_factory=list)
    strat_session_window_sast: Tuple[int, int] = None
    strat_htf_trend_filter: bool = False
    strat_min_stop_atr: float = 0.0
    strat_max_spread_in_r: float = 0.0


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

        if weekday == 4 and day <= 7:
            if hour == 12 and 20 <= minute <= 45:
                return True, "NFP First-Friday Macro Blackout (12:30 UTC)"

        if 10 <= day <= 16 and weekday in (1, 2, 3, 4):
            if hour == 12 and 20 <= minute <= 45:
                return True, "US CPI Release Macro Blackout (12:30 UTC)"

        if weekday == 2 and ((hour == 17 and minute >= 50) or (hour == 18 and minute <= 20)):
            return True, "FOMC Interest Rate Decision Blackout (18:00 UTC)"

        return False, ""

    # ========================================================================
    # BRIEF item 5: Monday AND Thursday get 0.5x. Everything else full risk.
    # ========================================================================
    @classmethod
    def get_day_of_week_policy(cls, dt_utc: datetime = None) -> Tuple[bool, float, str]:
        times = cls.get_current_times(dt_utc)
        wd = times["SAST"].weekday()

        if wd == 0:  # Monday
            if GLOBAL_PARAMS.skip_monday_trading:
                return False, 0.0, "Monday Trading Blocked via Policy"
            return True, 0.5, "Monday Reduced Risk (50% Size)"

        if wd == 1:  # Tuesday
            return True, 1.0, "Tuesday Normal Trading"

        if wd == 2:  # Wednesday
            return True, 1.0, "Wednesday Normal Trading"

        if wd == 3:  # Thursday
            return True, 0.5, "Thursday Reduced Risk (50% Size)"

        if wd == 4:  # Friday
            return True, 1.0, "Friday Normal Trading"

        return True, 1.0, "Weekend"

    # ========================================================================
    # Hour / weekday blacklist gates.
    # Called from StrategyManager._apply_always_on_filters (live + backtest).
    # ========================================================================

    @classmethod
    def is_blocked_hour(cls, symbol: str, dt_utc: datetime = None) -> Tuple[bool, str]:
        """True if the current SAST hour is blacklisted for this symbol."""
        times = cls.get_current_times(dt_utc)
        hour_sast = times["SAST"].hour
        blocked = getattr(GLOBAL_PARAMS, "blocked_hours_sast", {}) or {}
        hours = blocked.get(symbol.upper(), [])
        if hour_sast in hours:
            return True, f"BLOCKED_HOUR_{hour_sast:02d}_SAST"
        return False, ""

    @classmethod
    def is_blocked_weekday(cls, symbol: str, dt_utc: datetime = None) -> Tuple[bool, str]:
        """True if the current SAST weekday is blacklisted for this symbol."""
        times = cls.get_current_times(dt_utc)
        wd = times["SAST"].weekday()
        blocked = getattr(GLOBAL_PARAMS, "blocked_weekdays", {}) or {}
        days = blocked.get(symbol.upper(), [])
        if wd in days:
            return True, f"BLOCKED_WEEKDAY_{wd}"
        return False, ""
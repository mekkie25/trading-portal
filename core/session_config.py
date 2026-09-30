"""
trading-portal/core/session_config.py
Session configurations, Market Timings, DST Management and News Blackouts.
South African Standard Time (SAST) is UTC+2 (no DST).
UK (London) shifts between GMT (UTC+0) and BST (UTC+1).
US (New York) shifts between EST (UTC-5) and EDT (UTC-4).
"""

from datetime import datetime, timezone, time
from zoneinfo import ZoneInfo
from typing import Tuple, Dict, Any

try:
    from config.strategy_params import GLOBAL_PARAMS
except ImportError:
    import sys, os
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
    from config.strategy_params import GLOBAL_PARAMS

TZ_SAST = ZoneInfo("Africa/Johannesburg")
TZ_LONDON = ZoneInfo("Europe/London")
TZ_NEWYORK = ZoneInfo("America/New_York")
TZ_UTC = ZoneInfo("UTC")

class MarketSessionManager:
    """
    Manages session detection with true Daylight Saving Time (DST) tracking.
    London and New York sessions are evaluated in their native exchange timezones
    to guarantee market opens align perfectly year-round.
    """

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
        """Asian Session: 01:00 - 06:00 SAST (Spec Section 1 & 2)."""
        times = cls.get_current_times(dt_utc)
        t_sast = times["SAST"].time()
        return time(1, 0) <= t_sast < time(6, 0)

    @classmethod
    def is_in_london_open(cls, dt_utc: datetime = None) -> bool:
        """London Open: 08:00 - 10:00 Local London Time (UK Open)."""
        times = cls.get_current_times(dt_utc)
        t_london = times["LONDON"].time()
        return time(8, 0) <= t_london <= time(10, 0)

    @classmethod
    def is_in_london_fix(cls, dt_utc: datetime = None) -> bool:
        """London Fix: 10:30 UK / 11:30 SAST Window."""
        times = cls.get_current_times(dt_utc)
        t_london = times["LONDON"].time()
        return time(10, 25) <= t_london <= time(10, 45)

    @classmethod
    def is_in_ny_open(cls, dt_utc: datetime = None) -> bool:
        """New York Open: 09:30 - 11:00 US/Eastern Time (Spec Section 1)."""
        times = cls.get_current_times(dt_utc)
        t_ny = times["NEWYORK"].time()
        return time(9, 30) <= t_ny <= time(11, 0)

    @classmethod
    def is_in_ny_cracker_window(cls, dt_utc: datetime = None) -> bool:
        """NY Cracker Window: 09:30 - 10:30 US/Eastern (First hour of NYSE)."""
        times = cls.get_current_times(dt_utc)
        t_ny = times["NEWYORK"].time()
        return time(9, 30) <= t_ny <= time(10, 30)

    @classmethod
    def is_post_asia_grubber_window(cls, dt_utc: datetime = None) -> bool:
        """Grubber Kick Window: After 06:00 SAST, before 21:00 SAST EOD close."""
        times = cls.get_current_times(dt_utc)
        t_sast = times["SAST"].time()
        return time(6, 0) <= t_sast < time(21, 0)

    @classmethod
    def is_blackout_active(cls, dt_utc: datetime = None, blackout_minutes: int = 15) -> Tuple[bool, str]:
        """Enforces a hard news blackout blocking entries (Spec Section 3 & 7)."""
        if dt_utc is None:
            dt_utc = datetime.now(timezone.utc)
        elif dt_utc.tzinfo is None:
            dt_utc = dt_utc.replace(tzinfo=timezone.utc)

        # Configured blackout timestamps
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

        # First Friday NFP (12:30 UTC release window: 12:20 - 12:45)
        if weekday == 4 and day <= 7:
            if hour == 12 and 20 <= minute <= 45:
                return True, "NFP First-Friday Macro Blackout (12:30 UTC)"

        # Mid-month CPI (12:30 UTC release window: 12:20 - 12:45)
        if 10 <= day <= 16 and weekday in (1, 2, 3, 4):
            if hour == 12 and 20 <= minute <= 45:
                return True, "US CPI Release Macro Blackout (12:30 UTC)"

        # Wednesday FOMC Rate Decision (18:00 UTC / 20:00 SAST)
        if weekday == 2 and ((hour == 17 and minute >= 50) or (hour == 18 and minute <= 20)):
            return True, "FOMC Interest Rate Decision Blackout (18:00 UTC)"

        return False, ""

    @classmethod
    def get_day_of_week_policy(cls, dt_utc: datetime = None) -> Tuple[bool, float, str]:
        """Day-of-Week statistical filter (Spec Section 1)."""
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
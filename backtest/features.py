"""
backtest/features.py
Entry-time market-condition features for each trade. Zero look-ahead: every
value uses only data available at the entry candle.

Called by runner.py right before sim.open_trade. The returned dict is stored
with the trade and later pooled by backtest/entry_analysis.py.

PROPOSED: backtest-only. No effect on live trading.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional

import numpy as np
import pandas as pd

try:
    from core.session_config import TZ_LONDON, TZ_NEWYORK, TZ_SAST
except ImportError:
    from zoneinfo import ZoneInfo
    TZ_LONDON = ZoneInfo("Europe/London")
    TZ_NEWYORK = ZoneInfo("America/New_York")
    TZ_SAST = ZoneInfo("Africa/Johannesburg")


FEATURE_NAMES = [
    # Existing 12
    "htf_d1",
    "htf_h4",
    "ema200_dist_atr",
    "ema_spread_atr",
    "eff_ratio_30",
    "atr_pctile",
    "adr_used",
    "mins_since_open",
    "room_atr",
    "stop_atr",
    "spread_r",
    "trade_of_day",
    # PROPOSED: five additional features requested by the entry-condition prompt
    "session",
    "hour_sast",
    "weekday",
    "direction",
    "setup_tag",
]


_KEY_LEVELS = (
    "pdh", "pdl",
    "pivot_r1", "pivot_s1",
    "pivot_r2", "pivot_s2",
    "asia_high", "asia_low",
    "orb_high", "orb_low",
)


def _safe_float(v: Any) -> Optional[float]:
    try:
        f = float(v)
        return f if np.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _last_closed_context(view_df: pd.DataFrame, ema_span: int):
    """Return (last_close, ema_value) using only closed bars, or None."""
    if view_df is None or len(view_df) == 0:
        return None
    df = view_df.dropna(subset=["close"]) if "close" in view_df.columns else view_df
    if df is None or len(df) < ema_span + 1:
        return None
    closed = df.iloc[:-1]
    if len(closed) < ema_span:
        return None
    try:
        ema = float(closed["close"].ewm(span=ema_span, adjust=False).mean().iloc[-1])
        last_close = float(closed["close"].iloc[-1])
    except Exception:
        return None
    return last_close, ema


def _align(direction: str, last_close: float, ema: float) -> int:
    d = (direction or "").upper()
    if d == "BUY":
        return 1 if last_close > ema else 0
    if d == "SELL":
        return 1 if last_close < ema else 0
    return 0


def _eff_ratio(m5_slice: pd.DataFrame, window: int = 30) -> float:
    if m5_slice is None or len(m5_slice) < window + 1:
        return 0.0
    try:
        closes = m5_slice["close"].astype(float).tail(window + 1).to_numpy()
    except Exception:
        return 0.0
    if closes.size < 2:
        return 0.0
    net = float(abs(closes[-1] - closes[0]))
    path = float(np.abs(np.diff(closes)).sum())
    return (net / path) if path > 0 else 0.0


def _mins_since_session_open(curr_time_utc: datetime) -> int:
    """
    60-minute bucket since the most recent of:
      - London 08:00 local
      - New York 09:30 local
    Returns -1 if neither has opened yet for the current UTC day.
    """
    if curr_time_utc is None:
        return -1
    if curr_time_utc.tzinfo is None:
        curr_time_utc = curr_time_utc.replace(tzinfo=timezone.utc)

    london_local = curr_time_utc.astimezone(TZ_LONDON)
    london_open = london_local.replace(hour=8, minute=0, second=0, microsecond=0)
    if london_open > london_local:
        london_open -= timedelta(days=1)
    london_utc = london_open.astimezone(timezone.utc)

    ny_local = curr_time_utc.astimezone(TZ_NEWYORK)
    ny_open = ny_local.replace(hour=9, minute=30, second=0, microsecond=0)
    if ny_open > ny_local:
        ny_open -= timedelta(days=1)
    ny_utc = ny_open.astimezone(timezone.utc)

    most_recent = london_utc if london_utc >= ny_utc else ny_utc
    if most_recent > curr_time_utc:
        return -1
    mins = int((curr_time_utc - most_recent).total_seconds() / 60.0)
    return mins // 60


def _room_atr(session_levels: Optional[Dict[str, Any]], entry: float, direction: str, atr: float) -> float:
    """Distance in ATR to the nearest key level beyond the entry."""
    if atr <= 0 or not session_levels:
        return 0.0
    candidates = []
    for key in _KEY_LEVELS:
        v = _safe_float(session_levels.get(key))
        if v is not None and v > 0:
            candidates.append(v)
    if not candidates:
        return 0.0
    d = (direction or "").upper()
    if d == "BUY":
        beyond = [lv for lv in candidates if lv > entry]
        if not beyond:
            return 0.0
        return (min(beyond) - entry) / atr
    if d == "SELL":
        beyond = [lv for lv in candidates if lv < entry]
        if not beyond:
            return 0.0
        return (entry - max(beyond)) / atr
    return 0.0


def _atr_pctile(m5_df: pd.DataFrame, idx: int, lookback_bars: int = 20 * 288) -> float:
    """Percentile rank of ATR14 at idx against the last 20 M5-day window."""
    if m5_df is None or "atr_14" not in m5_df.columns:
        return 0.0
    series = m5_df["atr_14"]
    if idx < 0 or idx >= len(series):
        return 0.0
    current = _safe_float(series.iloc[idx])
    if current is None or current <= 0:
        return 0.0
    start = max(0, idx - lookback_bars)
    hist = series.iloc[start:idx + 1].dropna()
    if len(hist) < 10:
        return 0.0
    return float((hist < current).mean() * 100.0)


def _atr_fallback(m5_slice: pd.DataFrame) -> float:
    if m5_slice is None or len(m5_slice) < 15:
        return 0.0
    try:
        h = m5_slice["high"].astype(float)
        l = m5_slice["low"].astype(float)
        c = m5_slice["close"].astype(float)
        pc = c.shift(1)
        tr = pd.concat([(h - l).abs(), (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
        v = tr.tail(14).mean()
    except Exception:
        return 0.0
    return float(v) if np.isfinite(v) else 0.0


# ---------------------------------------------------------------------------
# PROPOSED: five new features. All read-only, all zero look-ahead.
# ---------------------------------------------------------------------------

def _session_code(curr_time_utc: datetime) -> int:
    """
    PROPOSED. Session in force on the SAST wall clock:
      0 = Asia         (01:00 - 06:00 SAST)
      1 = London only  (08:00 - 15:30 SAST)
      2 = New York only (17:00 - 23:00 SAST)
      3 = Overlap      (15:30 - 17:00 SAST)
      4 = Off-hours
    """
    if curr_time_utc is None:
        return 4
    if curr_time_utc.tzinfo is None:
        curr_time_utc = curr_time_utc.replace(tzinfo=timezone.utc)
    t = curr_time_utc.astimezone(TZ_SAST)
    mins = t.hour * 60 + t.minute
    if 60 <= mins < 360:
        return 0
    if 930 <= mins < 1020:
        return 3
    if 480 <= mins < 930:
        return 1
    if 1020 <= mins < 1380:
        return 2
    return 4


def _hour_sast_block(curr_time_utc: datetime) -> int:
    """PROPOSED. SAST hour grouped into 3-hour blocks (0..7). -1 if unknown."""
    if curr_time_utc is None:
        return -1
    if curr_time_utc.tzinfo is None:
        curr_time_utc = curr_time_utc.replace(tzinfo=timezone.utc)
    return int(curr_time_utc.astimezone(TZ_SAST).hour // 3)


def _weekday_code(curr_time_utc: datetime) -> int:
    """PROPOSED. SAST weekday: 0=Monday .. 6=Sunday. -1 if unknown."""
    if curr_time_utc is None:
        return -1
    if curr_time_utc.tzinfo is None:
        curr_time_utc = curr_time_utc.replace(tzinfo=timezone.utc)
    return int(curr_time_utc.astimezone(TZ_SAST).weekday())


def _direction_code(direction: str) -> int:
    """PROPOSED. +1 for BUY, -1 for SELL, 0 for unknown."""
    d = (direction or "").upper()
    if d == "BUY":
        return 1
    if d == "SELL":
        return -1
    return 0


def _setup_tag(signal: Any) -> str:
    """
    PROPOSED. Reads a sub-type label already present on the signal, if any.
    Does not add, change or compute anything on the strategies. Falls back to
    the literal string 'none' when nothing is present.
    """
    if signal is None:
        return "none"
    tag = getattr(signal, "setup_tag", None)
    if tag is None or tag == "":
        return "none"
    return str(tag)


def compute_entry_features(
    signal: Any,
    curr_time: datetime,
    m5_df: pd.DataFrame,
    idx: int,
    session_levels: Optional[Dict[str, Any]],
    active_vol: Optional[Dict[str, Any]],
    d1_view: Optional[pd.DataFrame],
    h4_view: Optional[pd.DataFrame],
    spread: float,
    trade_of_day: int,
) -> Dict[str, Any]:
    """
    Compute the features for one trade. Never raises; returns zeros/none on
    any internal failure so the run continues.
    """
    out: Dict[str, Any] = {k: 0 for k in FEATURE_NAMES}
    out["setup_tag"] = "none"  # PROPOSED: string feature, default safe value
    try:
        if signal is None or m5_df is None or idx < 0 or idx >= len(m5_df):
            return out

        entry = float(signal.entry_price)
        direction = str(signal.direction).upper()

        m5_slice = m5_df.iloc[max(0, idx - 120):idx + 1]

        atr = 0.0
        if "atr_14" in m5_df.columns:
            atr = _safe_float(m5_df["atr_14"].iloc[idx]) or 0.0
        if atr <= 0:
            atr = _atr_fallback(m5_slice)

        # (a) D1 alignment
        ctx = _last_closed_context(d1_view, 20)
        if ctx is not None:
            out["htf_d1"] = _align(direction, ctx[0], ctx[1])

        # (b) H4 alignment
        ctx = _last_closed_context(h4_view, 50)
        if ctx is not None:
            out["htf_h4"] = _align(direction, ctx[0], ctx[1])

        # (c) EMA200 distance in ATR, signed to the trade direction
        if atr > 0 and "ema_200" in m5_df.columns:
            ema200 = _safe_float(m5_df["ema_200"].iloc[idx])
            if ema200 is not None:
                sign = 1.0 if direction == "BUY" else (-1.0 if direction == "SELL" else 0.0)
                out["ema200_dist_atr"] = float(sign * (entry - ema200) / atr)

        # (d) EMA5-EMA13 spread in ATR
        if atr > 0 and "ema_5" in m5_df.columns and "ema_13" in m5_df.columns:
            e5 = _safe_float(m5_df["ema_5"].iloc[idx])
            e13 = _safe_float(m5_df["ema_13"].iloc[idx])
            if e5 is not None and e13 is not None:
                out["ema_spread_atr"] = float(abs(e5 - e13) / atr)

        # (e) Efficiency ratio over last 30 M5 candles
        out["eff_ratio_30"] = _eff_ratio(m5_slice, window=30)

        # (f) ATR14 percentile within the last 20 days
        out["atr_pctile"] = _atr_pctile(m5_df, idx)

        # (g) ADR used today
        if active_vol and active_vol.get("valid", False):
            adr = _safe_float(active_vol.get("adr"))
            consumed = _safe_float(active_vol.get("range_consumed"))
            if adr and adr > 0 and consumed is not None:
                out["adr_used"] = float(consumed / adr)

        # (h) Minutes since most recent session open, in 60-min buckets
        out["mins_since_open"] = _mins_since_session_open(curr_time)

        # (i) Room to nearest key level beyond entry, in ATR
        out["room_atr"] = _room_atr(session_levels, entry, direction, atr)

        # (j) Stop distance in ATR
        sl_dist = abs(entry - float(signal.stop_loss))
        if atr > 0:
            out["stop_atr"] = float(sl_dist / atr)

        # (k) Spread / stop distance
        if sl_dist > 0 and spread and spread > 0:
            out["spread_r"] = float(spread / sl_dist)

        # (l) Trade of day (1-indexed)
        try:
            tod = int(trade_of_day)
        except (TypeError, ValueError):
            tod = 1
        out["trade_of_day"] = tod if tod > 0 else 1

        # ------------------------------------------------------------------
        # PROPOSED: five additional features.
        # ------------------------------------------------------------------
        out["session"] = int(_session_code(curr_time))
        out["hour_sast"] = int(_hour_sast_block(curr_time))
        out["weekday"] = int(_weekday_code(curr_time))
        out["direction"] = int(_direction_code(direction))
        out["setup_tag"] = _setup_tag(signal)

    except Exception:
        # Feature computation must never break a backtest run.
        pass
    return out
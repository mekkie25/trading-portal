"""
core/session_levels.py
Single Source of Truth for Session Levels (PDH/PDL, Pivots, Asia H/L, Frozen ORB, Weekly Open).
Shared identically by both the live Matrix engine and the historical backtester.
"""

import pandas as pd
from datetime import datetime, timezone
from typing import Dict, Tuple, Any, Optional
from core.session_config import MarketSessionManager

def compute_frozen_opening_range(
    symbol: str,
    m5_df: pd.DataFrame,
    frozen_cache: Dict[Tuple[str, str], Dict[str, Any]],
    as_of: Optional[datetime] = None
) -> Tuple[float, float, bool, float, float, bool]:
    """
    Computes and freezes the initial 15M ORB and 5M Cracker ranges.
    """
    now = as_of if as_of is not None else datetime.now(timezone.utc)
    today_str = now.strftime("%Y-%m-%d")
    cache_key = (symbol, today_str)

    if cache_key in frozen_cache:
        entry = frozen_cache[cache_key]
        return (
            entry['high'], entry['low'], True,
            entry.get('cracker_high', entry['high']),
            entry.get('cracker_low', entry['low']), True
        )

    times = MarketSessionManager.get_current_times(now)
    in_london = MarketSessionManager.is_in_london_open(now)
    in_ny = MarketSessionManager.is_in_ny_open(now)

    if not (in_london or in_ny):
        h, l = float(m5_df['high'].tail(12).max()), float(m5_df['low'].tail(12).min())
        return h, l, True, h, l, True

    m5_df_time = pd.to_datetime(m5_df['time'], utc=True)
    if in_london:
        t_open_local = times["LONDON"].replace(hour=8, minute=0, second=0, microsecond=0)
        t_open_utc = t_open_local.astimezone(timezone.utc)
    else:
        t_open_local = times["NEWYORK"].replace(hour=9, minute=30, second=0, microsecond=0)
        t_open_utc = t_open_local.astimezone(timezone.utc)

    session_candles = m5_df[m5_df_time >= t_open_utc]

    cracker_h = float(session_candles.head(1)['high'].max()) if len(session_candles) >= 1 else 0.0
    cracker_l = float(session_candles.head(1)['low'].min()) if len(session_candles) >= 1 else 0.0
    cracker_established = len(session_candles) >= 1

    if len(session_candles) < 3:
        return 0.0, 0.0, False, cracker_h, cracker_l, cracker_established

    first_3_candles = session_candles.head(3)
    orb_h = float(first_3_candles['high'].max())
    orb_l = float(first_3_candles['low'].min())

    frozen_cache[cache_key] = {
        'high': orb_h,
        'low': orb_l,
        'cracker_high': cracker_h,
        'cracker_low': cracker_l
    }
    return orb_h, orb_l, True, cracker_h, cracker_l, True

def build_session_levels(
    symbol: str,
    m5_df: pd.DataFrame,
    d1_df: pd.DataFrame,
    vp_node: Any,
    frozen_orbs: Dict[Tuple[str, str], Dict[str, Any]],
    as_of: Optional[datetime] = None,
    adr_val: Optional[float] = None
) -> Dict[str, Any]:
    """
    Builds the standardized session_levels dictionary required by all strategies.
    """
    # 1. Previous Day High, Low, Close (PDH / PDL / PDC)
    if len(d1_df) >= 2:
        prev_d1 = d1_df.iloc[-2]
        pdh = float(prev_d1['high'])
        pdl = float(prev_d1['low'])
        pdc = float(prev_d1['close'])
    else:
        pdh = float(m5_df['high'].max())
        pdl = float(m5_df['low'].min())
        pdc = float(m5_df.iloc[-1]['close'])

    daily_pivot = (pdh + pdl + pdc) / 3.0
    pivot_r1 = (2.0 * daily_pivot) - pdl
    pivot_s1 = (2.0 * daily_pivot) - pdh
    pivot_r2 = daily_pivot + (pdh - pdl)
    pivot_s2 = daily_pivot - (pdh - pdl)
    daily_eq = (pdh + pdl) / 2.0

    # 2. Asian Range (01:00 to 06:00 SAST / 23:00 to 04:00 UTC)
    m5_times = pd.to_datetime(m5_df['time'], utc=True)
    asia_candles = m5_df[(m5_times.dt.hour >= 23) | (m5_times.dt.hour < 4)]
    if not asia_candles.empty:
        asia_high = float(asia_candles['high'].max())
        asia_low = float(asia_candles['low'].min())
    else:
        asia_high = float(m5_df['high'].tail(36).max())
        asia_low = float(m5_df['low'].tail(36).min())

    # 3. Weekly Open (+3h shift so Sunday night 21:00 UTC groups into Monday's ISO week)
    weekly_open = float(d1_df.iloc[-1]['open']) if not d1_df.empty else float(m5_df.iloc[-1]['open'])
    if not d1_df.empty:
        d1_times_shifted = pd.to_datetime(d1_df['time'], utc=True) + pd.Timedelta(hours=3)
        curr_week = d1_times_shifted.iloc[-1].isocalendar().week
        curr_year = d1_times_shifted.iloc[-1].isocalendar().year
        week_bars = d1_df[(d1_times_shifted.dt.isocalendar().week == curr_week) & (d1_times_shifted.dt.isocalendar().year == curr_year)]
        if not week_bars.empty:
            weekly_open = float(week_bars.iloc[0]['open'])

    # 4. AVWAP Anchor Index (Start of Week)
    avwap_anchor_idx = 0
    if not m5_df.empty:
        mon_candles = m5_df[m5_times.dt.weekday == 0]
        if not mon_candles.empty:
            avwap_anchor_idx = int(m5_df.index.get_loc(mon_candles.index[0]))

    # 5. Opening Range (15M & 5M Cracker)
    orb_h, orb_l, orb_est, cracker_h, cracker_l, cracker_est = compute_frozen_opening_range(
        symbol, m5_df, frozen_orbs, as_of=as_of
    )

    # 6. Extract Volume Profile properties
    poc = getattr(vp_node, 'poc_price', getattr(vp_node, 'poc', 0.0))
    vah = getattr(vp_node, 'value_area_high', getattr(vp_node, 'vah', 0.0))
    val = getattr(vp_node, 'value_area_low', getattr(vp_node, 'val', 0.0))

    return {
        "asia_high": asia_high,
        "asia_low": asia_low,
        "daily_eq": daily_eq,
        "pdh": pdh,
        "pdl": pdl,
        "daily_pivot": daily_pivot,
        "pivot_r1": pivot_r1,
        "pivot_s1": pivot_s1,
        "pivot_r2": pivot_r2,
        "pivot_s2": pivot_s2,
        "orb_high": orb_h,
        "orb_low": orb_l,
        "orb_established": orb_est,
        "cracker_orb_high": cracker_h,
        "cracker_orb_low": cracker_l,
        "cracker_orb_established": cracker_est,
        "weekly_open": weekly_open,
        "d1_open": float(d1_df.iloc[-1]['open']) if not d1_df.empty else float(m5_df.iloc[-1]['open']),
        "adr": adr_val,
        "avwap_anchor_index": avwap_anchor_idx,
        "poc": poc,
        "vah": vah,
        "val": val,
        "is_ranging": False,
        "range_span": 0.0
    }
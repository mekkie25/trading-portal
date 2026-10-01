"""
backtest/bar_aggregator.py
Rebuilds developing H1, H4, and D1 bars dynamically from closed M5 data up to time T.
Guarantees STRICT ZERO LOOK-AHEAD bias: never uses a higher timeframe bar before it closes.
"""

import pandas as pd
from datetime import datetime, timezone, timedelta
from typing import Tuple

class ZeroLookAheadAggregator:
    def __init__(self, d1_history: pd.DataFrame, h4_history: pd.DataFrame, h1_history: pd.DataFrame):
        self.d1_all = d1_history.copy()
        self.h4_all = h4_history.copy()
        self.h1_all = h1_history.copy()

        for df in [self.d1_all, self.h4_all, self.h1_all]:
            if not isinstance(df.index, pd.DatetimeIndex):
                df['dt'] = pd.to_datetime(df['time'], utc=True)
                df.set_index('dt', inplace=True)
                df.sort_index(inplace=True)

    def get_feeds_at_time(
        self,
        m5_history_up_to_t: pd.DataFrame,
        current_time_utc: datetime
    ) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
        """
        Returns exactly (H1, H4, D1) as the live bot would see them at current_time_utc.
        The last bar of each timeframe is the partially-formed bar aggregated from M5 up to T.
        """
        # --- 1. DAILY BARS (cTrader D1 opens at 21:00 or 22:00 UTC) ---
        # Any completed D1 bar must have opened at least 24h before now
        completed_d1 = self.d1_all[self.d1_all.index + pd.Timedelta(hours=24) <= current_time_utc].copy()
        
        # Determine the start of the current forming D1 candle
        # cTrader open is 21:00 UTC (winter) or 22:00 UTC (summer). Check latest completed D1 open hour:
        last_d1_open_hour = completed_d1.index[-1].hour if not completed_d1.empty else 21
        d1_start = current_time_utc.replace(hour=last_d1_open_hour, minute=0, second=0, microsecond=0)
        if current_time_utc < d1_start:
            d1_start -= timedelta(days=1)

        m5_times = pd.to_datetime(m5_history_up_to_t['time'], utc=True)
        m5_today = m5_history_up_to_t[m5_times >= d1_start]

        if not m5_today.empty:
            forming_d1 = pd.DataFrame([{
                'time': d1_start.strftime("%Y-%m-%d %H:%M:%S"),
                'open': float(m5_today['open'].iloc[0]),
                'high': float(m5_today['high'].max()),
                'low': float(m5_today['low'].min()),
                'close': float(m5_today['close'].iloc[-1]),
                'volume': int(m5_today['volume'].sum())
            }], index=[d1_start])
            active_d1 = pd.concat([completed_d1.tail(149), forming_d1])
        else:
            active_d1 = completed_d1.tail(150)

        # --- 2. H4 BARS (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC) ---
        completed_h4 = self.h4_all[self.h4_all.index + pd.Timedelta(hours=4) <= current_time_utc].copy()
        h4_start_hour = (current_time_utc.hour // 4) * 4
        h4_start = current_time_utc.replace(hour=h4_start_hour, minute=0, second=0, microsecond=0)

        m5_h4 = m5_history_up_to_t[m5_times >= h4_start]
        if not m5_h4.empty:
            forming_h4 = pd.DataFrame([{
                'time': h4_start.strftime("%Y-%m-%d %H:%M:%S"),
                'open': float(m5_h4['open'].iloc[0]),
                'high': float(m5_h4['high'].max()),
                'low': float(m5_h4['low'].min()),
                'close': float(m5_h4['close'].iloc[-1]),
                'volume': int(m5_h4['volume'].sum())
            }], index=[h4_start])
            active_h4 = pd.concat([completed_h4.tail(29), forming_h4])
        else:
            active_h4 = completed_h4.tail(30)

        # --- 3. H1 BARS ---
        completed_h1 = self.h1_all[self.h1_all.index + pd.Timedelta(hours=1) <= current_time_utc].copy()
        h1_start = current_time_utc.replace(minute=0, second=0, microsecond=0)

        m5_h1 = m5_history_up_to_t[m5_times >= h1_start]
        if not m5_h1.empty:
            forming_h1 = pd.DataFrame([{
                'time': h1_start.strftime("%Y-%m-%d %H:%M:%S"),
                'open': float(m5_h1['open'].iloc[0]),
                'high': float(m5_h1['high'].max()),
                'low': float(m5_h1['low'].min()),
                'close': float(m5_h1['close'].iloc[-1]),
                'volume': int(m5_h1['volume'].sum())
            }], index=[h1_start])
            active_h1 = pd.concat([completed_h1.tail(29), forming_h1])
        else:
            active_h1 = completed_h1.tail(30)

        return active_h1.reset_index(drop=True), active_h4.reset_index(drop=True), active_d1.reset_index(drop=True)
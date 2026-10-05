"""
backtest/bar_aggregator.py
Rebuilds developing H1, H4, and D1 bars dynamically from closed M5 data up to time T.
Guarantees STRICT ZERO LOOK-AHEAD bias: never uses a higher timeframe bar before it closes.
Optimized with pre-allocated buffer views and in-place forming candle updates.
Zero DataFrame creation, concatenation, or copying on each candle.
"""

import bisect
import numpy as np
import pandas as pd
from datetime import datetime, timezone, timedelta
from typing import Tuple, Optional


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

        # Precompute close timestamps as integer epochs for fast bisect
        self._d1_close_epochs = [int((t + pd.Timedelta(hours=24)).timestamp()) for t in self.d1_all.index]
        self._h4_close_epochs = [int((t + pd.Timedelta(hours=4)).timestamp()) for t in self.h4_all.index]
        self._h1_close_epochs = [int((t + pd.Timedelta(hours=1)).timestamp()) for t in self.h1_all.index]

        # Pre-allocated fixed buffer DataFrames: rows 0..N-2 are completed, row N-1 is forming
        self._d1_buffer = self._init_buffer(self.d1_all, 150)
        self._h4_buffer = self._init_buffer(self.h4_all, 30)
        self._h1_buffer = self._init_buffer(self.h1_all, 30)

        self._cached_d1_idx = -1
        self._cached_h4_idx = -1
        self._cached_h1_idx = -1

    def _init_buffer(self, source_df: pd.DataFrame, size: int) -> pd.DataFrame:
        cols = ['time', 'open', 'high', 'low', 'close', 'volume']
        sample = source_df[cols].tail(size).copy().reset_index(drop=True)
        if len(sample) < size:
            pad = pd.DataFrame(index=range(size - len(sample)), columns=cols)
            sample = pd.concat([pad, sample], ignore_index=True)
        return sample

    def get_feeds_at_time(
        self,
        m5_history_up_to_t: pd.DataFrame,
        current_time_utc: datetime
    ) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
        """
        Returns exactly (H1, H4, D1) views without per-candle allocation or concatenation.
        """
        curr_epoch = int(current_time_utc.timestamp())

        if not pd.api.types.is_datetime64_any_dtype(m5_history_up_to_t['time']):
            m5_times = pd.to_datetime(m5_history_up_to_t['time'], utc=True)
        else:
            m5_times = m5_history_up_to_t['time']

        vol_col = 'volume' if 'volume' in m5_history_up_to_t.columns else 'tick_volume'

        # --- 1. DAILY BARS (cTrader D1 opens at 21:00 or 22:00 UTC) ---
        d1_idx = bisect.bisect_right(self._d1_close_epochs, curr_epoch)
        if d1_idx != self._cached_d1_idx:
            self._cached_d1_idx = d1_idx
            completed_slice = self.d1_all[['time', 'open', 'high', 'low', 'close', 'volume']].iloc[max(0, d1_idx - 149):d1_idx]
            n_rows = len(completed_slice)
            self._d1_buffer.iloc[149 - n_rows:149] = completed_slice.values

        last_d1_open_hour = self.d1_all.index[d1_idx - 1].hour if d1_idx > 0 else 21
        d1_start = current_time_utc.replace(hour=last_d1_open_hour, minute=0, second=0, microsecond=0)
        if current_time_utc < d1_start:
            d1_start -= timedelta(days=1)

        m5_today = m5_history_up_to_t[m5_times >= d1_start]
        if not m5_today.empty:
            o = float(m5_today['open'].iloc[0])
            h = float(m5_today['high'].max())
            l = float(m5_today['low'].min())
            c = float(m5_today['close'].iloc[-1])
            v = int(m5_today[vol_col].sum())
            t_str = d1_start.strftime("%Y-%m-%d %H:%M:%S")
            self._d1_buffer.iloc[149] = [t_str, o, h, l, c, v]
            active_d1 = self._d1_buffer
        else:
            active_d1 = self._d1_buffer.iloc[:149].reset_index(drop=True)

        # --- 2. H4 BARS (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC) ---
        h4_idx = bisect.bisect_right(self._h4_close_epochs, curr_epoch)
        if h4_idx != self._cached_h4_idx:
            self._cached_h4_idx = h4_idx
            completed_slice = self.h4_all[['time', 'open', 'high', 'low', 'close', 'volume']].iloc[max(0, h4_idx - 29):h4_idx]
            n_rows = len(completed_slice)
            self._h4_buffer.iloc[29 - n_rows:29] = completed_slice.values

        h4_start_hour = (current_time_utc.hour // 4) * 4
        h4_start = current_time_utc.replace(hour=h4_start_hour, minute=0, second=0, microsecond=0)

        m5_h4 = m5_history_up_to_t[m5_times >= h4_start]
        if not m5_h4.empty:
            o = float(m5_h4['open'].iloc[0])
            h = float(m5_h4['high'].max())
            l = float(m5_h4['low'].min())
            c = float(m5_h4['close'].iloc[-1])
            v = int(m5_h4[vol_col].sum())
            t_str = h4_start.strftime("%Y-%m-%d %H:%M:%S")
            self._h4_buffer.iloc[29] = [t_str, o, h, l, c, v]
            active_h4 = self._h4_buffer
        else:
            active_h4 = self._h4_buffer.iloc[:29].reset_index(drop=True)

        # --- 3. H1 BARS ---
        h1_idx = bisect.bisect_right(self._h1_close_epochs, curr_epoch)
        if h1_idx != self._cached_h1_idx:
            self._cached_h1_idx = h1_idx
            completed_slice = self.h1_all[['time', 'open', 'high', 'low', 'close', 'volume']].iloc[max(0, h1_idx - 29):h1_idx]
            n_rows = len(completed_slice)
            self._h1_buffer.iloc[29 - n_rows:29] = completed_slice.values

        h1_start = current_time_utc.replace(minute=0, second=0, microsecond=0)
        m5_h1 = m5_history_up_to_t[m5_times >= h1_start]
        if not m5_h1.empty:
            o = float(m5_h1['open'].iloc[0])
            h = float(m5_h1['high'].max())
            l = float(m5_h1['low'].min())
            c = float(m5_h1['close'].iloc[-1])
            v = int(m5_h1[vol_col].sum())
            t_str = h1_start.strftime("%Y-%m-%d %H:%M:%S")
            self._h1_buffer.iloc[29] = [t_str, o, h, l, c, v]
            active_h1 = self._h1_buffer
        else:
            active_h1 = self._h1_buffer.iloc[:29].reset_index(drop=True)

        return active_h1, active_h4, active_d1
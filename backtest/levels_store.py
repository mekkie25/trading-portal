"""
backtest/levels_store.py
Persistent per-pair store of precomputed levels, indicators and volatility
metrics.

For every M5 candle we precompute and store on disk:
  - session_high, session_low
  - asia_high, asia_low
  - pdh, pdl, pdc, weekly_open, d1_open
  - daily_pivot, pivot_r1, pivot_s1, pivot_r2, pivot_s2, daily_eq
  - orb_high, orb_low, cracker_high, cracker_low
  - poc, vah, val
  - ema_5, ema_9, ema_13, ema_25, ema_200 (exact 121-window values)
  - avwap_anchor_index
  - Volatility engine outputs, computed once per UTC day:
      vol_valid, adr, awr, amr, k_scale, regime_code,
      today_high, today_low, range_consumed, drc_pct
  - Forming H1, H4, D1 OHLCV at each candle.

All values use only candles up to that candle (zero look-ahead).

Incremental update: only candles after the last stored candle are computed,
with a 3-day overlap. Anything older than 500 days is dropped.

Format: {SYMBOL}_levels.npz (compressed), {SYMBOL}_levels_meta.json.
Roughly 5-8 MB per pair after compression for 365 days.
"""

import os
import json
import hashlib
import tempfile
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, Optional, Tuple, List

import numpy as np
import pandas as pd

from core.session_config import TZ_SAST, GLOBAL_PARAMS
from core.indicators import get_session_volume_profile, get_pivot_points
from backtest.paths import DATA_DIR

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

LEVEL_COLUMNS: List[str] = [
    # Session and daily levels
    "session_high", "session_low",
    "asia_high", "asia_low",
    "pdh", "pdl", "pdc",
    "daily_pivot", "pivot_r1", "pivot_s1", "pivot_r2", "pivot_s2", "daily_eq",
    "weekly_open", "d1_open",
    # Opening ranges
    "orb_high", "orb_low",
    "cracker_high", "cracker_low",
    # Volume profile
    "poc", "vah", "val",
    # EMAs (exact 121-window values)
    "ema_5", "ema_9", "ema_13", "ema_25", "ema_200",
    # AVWAP anchor
    "avwap_anchor_index",
    # Volatility engine outputs (per-candle; the values only change at day
    # boundaries but are stored per-candle so lookup is a simple index)
    "vol_valid", "adr", "awr", "amr", "k_scale", "regime_code",
    "today_high", "today_low", "range_consumed", "drc_pct",
    # Forming higher-timeframe candles
    "forming_h1_o", "forming_h1_h", "forming_h1_l", "forming_h1_c", "forming_h1_v",
    "forming_h4_o", "forming_h4_h", "forming_h4_l", "forming_h4_c", "forming_h4_v",
    "forming_d1_o", "forming_d1_h", "forming_d1_l", "forming_d1_c", "forming_d1_v",
]

LEVELS_FORMAT_VERSION = "2.0"

# Rolling window kept in the store
STORE_TARGET_DAYS_LOCAL = 500


def _source_hash() -> str:
    h = hashlib.sha256()
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    for rel in [
        "core/session_levels.py",
        "core/indicators.py",
        "core/session_config.py",
        "core/volatility_engine.py",
        "backtest/levels_store.py",
    ]:
        path = os.path.join(project_root, rel)
        try:
            with open(path, "rb") as f:
                h.update(rel.encode())
                h.update(f.read())
        except FileNotFoundError:
            h.update(rel.encode())
    h.update(LEVELS_FORMAT_VERSION.encode())
    return h.hexdigest()[:16]


def _store_paths(symbol: str) -> Tuple[str, str]:
    return (
        os.path.join(DATA_DIR, f"{symbol}_levels.npz"),
        os.path.join(DATA_DIR, f"{symbol}_levels_meta.json"),
    )


def _load_meta(symbol: str) -> Optional[Dict[str, Any]]:
    _, meta_path = _store_paths(symbol)
    if not os.path.exists(meta_path):
        return None
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_meta_atomic(symbol: str, meta: Dict[str, Any]) -> None:
    _, meta_path = _store_paths(symbol)
    dirname = os.path.dirname(meta_path)
    fd, tmp = tempfile.mkstemp(dir=dirname, prefix="tmp_meta_", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        os.replace(tmp, meta_path)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise


def _write_npz_atomic(npz_path: str, arrays: Dict[str, np.ndarray], meta_json: str) -> None:
    dirname = os.path.dirname(npz_path)
    fd, tmp = tempfile.mkstemp(dir=dirname, prefix="tmp_npz_", suffix=".npz")
    os.close(fd)
    try:
        np.savez_compressed(tmp, meta_json=np.array(meta_json), **arrays)
        os.replace(tmp, npz_path)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise


# ---------------------------------------------------------------------------
# Per-series computation
# ---------------------------------------------------------------------------

def _compute_levels_for_series(symbol: str, m5_df: pd.DataFrame, d1_df: pd.DataFrame) -> Dict[str, np.ndarray]:
    n = len(m5_df)
    out = {col: np.full(n, np.nan, dtype=np.float32) for col in LEVEL_COLUMNS}
    # avwap_anchor_index is an int; store in float and cast on read.
    out["avwap_anchor_index"] = np.full(n, np.nan, dtype=np.float32)
    # vol_valid and regime_code are 0/1/2 codes.
    out["vol_valid"] = np.zeros(n, dtype=np.float32)

    times = pd.to_datetime(m5_df["time"], utc=True)
    times_utc = times.dt.tz_convert("UTC")
    highs = m5_df["high"].astype(float).values
    lows = m5_df["low"].astype(float).values
    closes = m5_df["close"].astype(float).values
    opens = m5_df["open"].astype(float).values
    vols = (m5_df["volume"].astype(float).values
            if "volume" in m5_df.columns else np.ones(n, dtype=float))

    # EMAs (exact 121-window)
    for span in (5, 9, 13, 25, 200):
        alpha = 2.0 / (span + 1.0)
        wsize = 121
        if n >= wsize:
            weights = np.empty(wsize, dtype=np.float64)
            weights[0] = (1.0 - alpha) ** (wsize - 1)
            for k in range(1, wsize):
                weights[k] = alpha * ((1.0 - alpha) ** (wsize - 1 - k))
            valid = np.convolve(closes, weights[::-1], mode="valid")
            out[f"ema_{span}"][wsize - 1:] = valid.astype(np.float32)

    # Per-day trackers
    current_day = None
    day_high = -np.inf
    day_low = np.inf
    prev_day_high = np.nan
    prev_day_low = np.nan
    prev_day_close = np.nan

    # Weekly tracker
    current_week_key = None
    weekly_open = np.nan

    # Asia session trackers (23:00-04:00 UTC window)
    asia_high = np.nan
    asia_low = np.nan
    asia_frozen_for_day = None

    # London OR trackers (07:00-07:15 UTC for the 15M OR; 07:00-07:05 for the 5M cracker)
    orb_high = np.nan
    orb_low = np.nan
    cracker_high = np.nan
    cracker_low = np.nan

    # Volatility engine cache per day
    vol_cached_day = None
    vol_metrics = {"valid": False}

    # AVWAP anchor: index of the first candle of the current week (Monday)
    avwap_anchor_idx = 0

    # Volume profile refresh every 12 candles
    vp_interval = 12
    poc_v = vah_v = val_v = np.nan

    for i in range(n):
        t_utc = times_utc.iloc[i]
        hour_utc = t_utc.hour
        minute_utc = t_utc.minute
        day_key = t_utc.strftime("%Y-%m-%d")

        # Day change
        if day_key != current_day:
            if current_day is not None:
                prev_day_high = day_high
                prev_day_low = day_low
                prev_day_close = closes[i - 1]
            current_day = day_key
            day_high = highs[i]
            day_low = lows[i]
            asia_high = np.nan
            asia_low = np.nan
            asia_frozen_for_day = None
            orb_high = np.nan
            orb_low = np.nan
            cracker_high = np.nan
            cracker_low = np.nan
        else:
            day_high = max(day_high, highs[i])
            day_low = min(day_low, lows[i])

        # Week tracking (Monday 00:00 SAST)
        sast = times.iloc[i].tz_convert(TZ_SAST)
        week_key = (sast.isocalendar().year, sast.isocalendar().week)
        if week_key != current_week_key:
            current_week_key = week_key
            weekly_open = opens[i]
            avwap_anchor_idx = i

        # Asia window
        if hour_utc >= 23 or hour_utc < 4:
            if np.isnan(asia_high):
                asia_high = highs[i]
                asia_low = lows[i]
            else:
                asia_high = max(asia_high, highs[i])
                asia_low = min(asia_low, lows[i])
        if hour_utc >= 4 and asia_frozen_for_day != day_key:
            asia_frozen_for_day = day_key

        # London 15M OR (07:00-07:15 UTC)
        if hour_utc == 7 and minute_utc < 15:
            if np.isnan(orb_high):
                orb_high = highs[i]
                orb_low = lows[i]
            else:
                orb_high = max(orb_high, highs[i])
                orb_low = min(orb_low, lows[i])

        # London 5M cracker (first candle)
        if hour_utc == 7 and minute_utc < 5:
            if np.isnan(cracker_high):
                cracker_high = highs[i]
                cracker_low = lows[i]
            else:
                cracker_high = max(cracker_high, highs[i])
                cracker_low = min(cracker_low, lows[i])

        # Assign scalars
        out["session_high"][i] = day_high
        out["session_low"][i] = day_low
        out["asia_high"][i] = asia_high
        out["asia_low"][i] = asia_low
        out["pdh"][i] = prev_day_high
        out["pdl"][i] = prev_day_low
        out["pdc"][i] = prev_day_close
        out["weekly_open"][i] = weekly_open
        out["orb_high"][i] = orb_high
        out["orb_low"][i] = orb_low
        out["cracker_high"][i] = cracker_high
        out["cracker_low"][i] = cracker_low
        out["avwap_anchor_index"][i] = avwap_anchor_idx

        if not np.isnan(prev_day_high) and not np.isnan(prev_day_low) and not np.isnan(prev_day_close):
            piv = get_pivot_points(prev_day_high, prev_day_low, prev_day_close)
            out["daily_pivot"][i] = piv["P"]
            out["pivot_r1"][i] = piv["R1"]
            out["pivot_s1"][i] = piv["S1"]
            out["pivot_r2"][i] = piv["R2"]
            out["pivot_s2"][i] = piv["S2"]
            out["daily_eq"][i] = (prev_day_high + prev_day_low) / 2.0

        # Volume profile
        if i % vp_interval == 0 and i >= 5:
            try:
                day_slice = m5_df.iloc[max(0, i - 288):i + 1]
                vp = get_session_volume_profile(day_slice)
                poc_v = float(vp.get("poc", np.nan))
                vah_v = float(vp.get("vah", np.nan))
                val_v = float(vp.get("val", np.nan))
            except Exception:
                pass
        out["poc"][i] = poc_v
        out["vah"][i] = vah_v
        out["val"][i] = val_v

        # Volatility engine: compute once per day
        if vol_cached_day != day_key:
            try:
                from core.volatility_engine import volatility_engine
                slice_end = i + 1
                d1_slice = d1_df
                m5_slice = m5_df.iloc[:slice_end]
                metrics = volatility_engine.compute_symbol_volatility(
                    d1_df=d1_slice,
                    m5_df=m5_slice,
                    current_quote=float(closes[i]),
                    symbol=symbol,
                    as_of=t_utc.to_pydatetime(),
                )
                vol_metrics = metrics
            except Exception:
                vol_metrics = {"valid": False}
            vol_cached_day = day_key

        if vol_metrics.get("valid", False):
            out["vol_valid"][i] = 1.0
            out["adr"][i] = float(vol_metrics.get("adr", np.nan))
            out["awr"][i] = float(vol_metrics.get("awr", np.nan))
            out["amr"][i] = float(vol_metrics.get("amr", np.nan))
            out["k_scale"][i] = float(vol_metrics.get("k_scale", 1.0))
            regime = vol_metrics.get("regime", "NORMAL")
            out["regime_code"][i] = {"LOW": 0.0, "NORMAL": 1.0, "HIGH": 2.0}.get(regime, 1.0)
            out["today_high"][i] = float(vol_metrics.get("today_high", np.nan))
            out["today_low"][i] = float(vol_metrics.get("today_low", np.nan))
            out["range_consumed"][i] = float(vol_metrics.get("range_consumed", np.nan))
            out["drc_pct"][i] = float(vol_metrics.get("drc_pct", np.nan))
            out["d1_open"][i] = float(vol_metrics.get("d1_open", np.nan))

        # Forming H1, H4, D1
        # H1 start: floor to hour
        h1_start = t_utc.replace(minute=0, second=0, microsecond=0)
        h4_start = t_utc.replace(hour=(t_utc.hour // 4) * 4, minute=0, second=0, microsecond=0)
        d1_start = t_utc.replace(hour=0, minute=0, second=0, microsecond=0)

        # Walk backwards to find bucket starts; bounded by bucket size in candles
        def _find_start(bucket_start, max_back):
            j = i
            limit = max(0, i - max_back)
            while j > limit and times_utc.iloc[j] >= bucket_start:
                j -= 1
            return j + 1

        h1_idx = _find_start(h1_start, 12)
        h4_idx = _find_start(h4_start, 48)
        d1_idx = _find_start(d1_start, 288)

        for prefix, start in (("h1", h1_idx), ("h4", h4_idx), ("d1", d1_idx)):
            if start <= i:
                out[f"forming_{prefix}_o"][i] = opens[start]
                out[f"forming_{prefix}_h"][i] = float(np.max(highs[start:i + 1]))
                out[f"forming_{prefix}_l"][i] = float(np.min(lows[start:i + 1]))
                out[f"forming_{prefix}_c"][i] = closes[i]
                out[f"forming_{prefix}_v"][i] = float(np.sum(vols[start:i + 1]))

    return out


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_or_update_store(symbol: str, m5_df: pd.DataFrame, d1_df: pd.DataFrame) -> bool:
    current_hash = _source_hash()
    npz_path, _ = _store_paths(symbol)
    meta = _load_meta(symbol)

    # Decide whether to rebuild or append
    if meta and meta.get("levels_version") == current_hash and os.path.exists(npz_path):
        try:
            stored = np.load(npz_path, allow_pickle=False)
            stored_times = stored["time"].astype(np.int64)
            last_stored_epoch = int(stored_times.max()) if stored_times.size > 0 else 0
        except Exception:
            last_stored_epoch = 0

        m5_times = pd.to_datetime(m5_df["time"], utc=True)
        m5_epochs = (m5_times.astype("int64") // 10 ** 9).values

        overlap_seconds = 3 * 86400
        start_epoch = last_stored_epoch - overlap_seconds
        mask = m5_epochs >= start_epoch
        recompute_df = m5_df[mask].reset_index(drop=True)
        recompute_epochs = m5_epochs[mask]

        if recompute_df.empty:
            return True

        new_arrays = _compute_levels_for_series(symbol, recompute_df, d1_df)
        new_arrays["time"] = recompute_epochs.astype(np.int64)

        try:
            stored = np.load(npz_path, allow_pickle=False)
            keep_mask = stored["time"].astype(np.int64) < start_epoch
            kept = {k: stored[k][keep_mask] for k in stored.files if k != "meta_json"}
        except Exception:
            kept = {}

        merged: Dict[str, np.ndarray] = {}
        for k in set(list(kept.keys()) + list(new_arrays.keys())):
            old = kept.get(k)
            new = new_arrays.get(k)
            if old is None:
                merged[k] = new
            elif new is None:
                merged[k] = old
            else:
                merged[k] = np.concatenate([old, new])

        order = np.argsort(merged["time"])
        for k in merged:
            merged[k] = merged[k][order]

        cutoff_epoch = int(m5_epochs.max()) - STORE_TARGET_DAYS_LOCAL * 86400
        win = merged["time"] >= cutoff_epoch
        for k in merged:
            merged[k] = merged[k][win]

        meta_json = json.dumps({
            "levels_version": current_hash,
            "incremental_at": datetime.now(timezone.utc).isoformat(),
        })
        _write_npz_atomic(npz_path, merged, meta_json)
        _write_meta_atomic(symbol, {
            "symbol": symbol,
            "levels_version": current_hash,
            "first_candle_time": str(pd.to_datetime(int(merged["time"].min()), unit="s", utc=True)),
            "last_candle_time": str(pd.to_datetime(int(merged["time"].max()), unit="s", utc=True)),
            "candle_count": int(len(merged["time"])),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "mode": "incremental",
        })
        print(f"[store] {symbol}: incremental update, {len(merged['time']):,} candles total", flush=True)
        return True

    # Full rebuild
    print(f"[store] {symbol}: full rebuild ({len(m5_df):,} candles, one-time cost)", flush=True)
    arrays = _compute_levels_for_series(symbol, m5_df, d1_df)
    m5_times = pd.to_datetime(m5_df["time"], utc=True)
    arrays["time"] = (m5_times.astype("int64") // 10 ** 9).values.astype(np.int64)

    meta_json = json.dumps({
        "levels_version": current_hash,
        "full_build_at": datetime.now(timezone.utc).isoformat(),
    })
    _write_npz_atomic(npz_path, arrays, meta_json)
    _write_meta_atomic(symbol, {
        "symbol": symbol,
        "levels_version": current_hash,
        "first_candle_time": str(m5_times.iloc[0]),
        "last_candle_time": str(m5_times.iloc[-1]),
        "candle_count": int(len(arrays["time"])),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "full",
    })
    print(f"[store] {symbol}: full build complete", flush=True)
    return True


def load_store(symbol: str) -> Optional[Dict[str, np.ndarray]]:
    npz_path, _ = _store_paths(symbol)
    meta = _load_meta(symbol)
    if not meta or not os.path.exists(npz_path):
        return None
    if meta.get("levels_version") != _source_hash():
        return None
    try:
        loaded = np.load(npz_path, allow_pickle=False)
        return {k: loaded[k] for k in loaded.files if k != "meta_json"}
    except Exception:
        return None


def store_status(symbol: str) -> Dict[str, Any]:
    meta = _load_meta(symbol)
    if not meta:
        return {"symbol": symbol, "has_store": False}
    return {
        "symbol": symbol,
        "has_store": True,
        "first_candle_time": meta.get("first_candle_time"),
        "last_candle_time": meta.get("last_candle_time"),
        "candle_count": meta.get("candle_count"),
        "levels_version": meta.get("levels_version"),
        "updated_at": meta.get("updated_at"),
    }
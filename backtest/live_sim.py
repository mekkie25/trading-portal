"""
backtest/live_sim.py
Live Bot Portfolio Replay.

Simulates the LIVE bot as a single account. One TradeSimulator instance
across all pairs. One equity. One set of daily caps. One risk profile.
One timeline. Trades advance together.

This is the mode that answers: "What would the live bot have actually
done over the last N days on a single starting balance?"

Distinct from the Strategy Research mode, which runs each pair and each
combo in isolation to compare setups and conditions.

Design notes
------------
- One TradeSimulator instance shared by all pairs.
  - self.equity is portfolio equity.
  - self.daily_trade_counts is a portfolio-level counter.
  - Profile-based sizing uses the shared equity, exactly like live.
- One timeline: the union of every pair's M5 timestamps inside its
  per-pair window. Sorting by (timestamp, pair) makes the walk
  deterministic and identical between runs.
- Per-pair precompute caches are reused (identical to Strategy Research).
  No signal regeneration happens here. The cost is zero on a warm cache.
- Signals are filtered exactly as live does: pair_settings first,
  then adaptive volatility, then volatility filters, then open_trade.
  Anything that survives all four is a trade the live bot would take.
- Live behaviour for skips is preserved: pair-settings rejections, min
  lot rejections, daily cap rejections and EOD lockdowns are all recorded
  with reasons.

Author: NEXUS Matrix
"""

import os
import sys
import copy
import math
import json
import time
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Any, Optional, Tuple

import numpy as np
import pandas as pd

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from core.session_config import GLOBAL_PARAMS, TZ_SAST
from core.volatility_engine import volatility_engine
from core.pair_settings import (
    load_pair_settings,
    get_strategy_settings,
    passes_signal_filters,
    get_effective_rr,
    get_effective_be,
)
from backtest.simulator import TradeSimulator, ASSETS
from backtest.paths import DATA_DIR, OUTPUT_DIR
from backtest.report import calculate_kpis
from backtest.runner import (
    COMBINATIONS,
    _try_load_precompute,
    compute_121_window_emas,
    compute_atr14_series,
    sanitize_for_json,
)


WHITELIST_PAIRS = ["US30", "GOLD", "NAS100", "GERMAN30", "EURUSD", "GBPUSD", "USDJPY"]


class LivePortfolioSimulator:
    """
    Walk-forward single-account simulator for the live bot.

    Instantiate once per combo. Call .run() to walk the timeline and
    return a report dict.
    """

    def __init__(
        self,
        combo: Dict[str, Any],
        balance_usd: float,
        profile_name: Optional[str],
        pair_data: Dict[str, Dict[str, Any]],
        zar_per_usd: float = 18.0,
        pair_settings: Optional[Dict[str, Any]] = None,
    ):
        self.combo = combo
        self.balance_usd = float(balance_usd)
        self.profile_name = profile_name
        self.pair_data = pair_data
        self.pair_settings = pair_settings
        self.zar_per_usd = float(zar_per_usd) if zar_per_usd and zar_per_usd > 0 else 18.0
        self.combo_label = combo.get('label', 'Unknown')

        self.use_be = bool(combo.get('use_be', False))
        self.use_trail = bool(combo.get('use_trail', False))
        self.adaptive_mode = bool(combo.get('adaptive_mode', True))
        self.rr_override = combo.get('rr_override', None)

        # One shared simulator for the entire portfolio.
        self.sim = TradeSimulator(
            starting_balance=self.balance_usd,
            risk_pct=1.0,
            be_mode="FIXED_80",
            m5_df_full=None,
            profile_name=profile_name,
            zar_per_usd=self.zar_per_usd,
        )

        self.timeline = self._build_timeline()
        self.pair_setting_skips: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------
    # Timeline
    # ------------------------------------------------------------------

    def _build_timeline(self) -> List[Tuple[pd.Timestamp, str, int]]:
        """
        Build the union timeline as a sorted list of (timestamp, symbol, idx).

        Sort key is (timestamp, symbol). This makes the walk deterministic
        and identical between runs, regardless of how dict ordering changes.
        """
        events: List[Tuple[pd.Timestamp, str, int]] = []
        for sym, data in self.pair_data.items():
            m5 = data['m5_df']
            start = int(data['sim_start_idx'])
            total = len(m5)
            for idx in range(start, total):
                t = m5['time'].iloc[idx]
                events.append((t, sym, idx))
        events.sort(key=lambda x: (x[0], x[1]))
        return events

    # ------------------------------------------------------------------
    # Walk
    # ------------------------------------------------------------------

    def run(self) -> Dict[str, Any]:
        orig_rr = GLOBAL_PARAMS.target_rr
        orig_be = GLOBAL_PARAMS.use_breakeven
        orig_trail = GLOBAL_PARAMS.use_supertrend_trail
        orig_adaptive = GLOBAL_PARAMS.adaptive_mode

        try:
            if self.rr_override is not None:
                GLOBAL_PARAMS.target_rr = float(self.rr_override)
            GLOBAL_PARAMS.use_breakeven = self.use_be
            GLOBAL_PARAMS.use_supertrend_trail = self.use_trail
            GLOBAL_PARAMS.adaptive_mode = self.adaptive_mode

            for t, sym, idx in self.timeline:
                self._process_event(t, sym, idx)

            self._close_all_at_end()
        finally:
            GLOBAL_PARAMS.target_rr = orig_rr
            GLOBAL_PARAMS.use_breakeven = orig_be
            GLOBAL_PARAMS.use_supertrend_trail = orig_trail
            GLOBAL_PARAMS.adaptive_mode = orig_adaptive

        return self._build_report()

    def _process_event(self, t: pd.Timestamp, sym: str, idx: int) -> None:
        m5 = self.pair_data[sym]['m5_df']

        # 1. Advance any open positions on this pair with the current bar.
        has_on_sym = any(p['symbol'] == sym for p in self.sim.open_positions)
        has_pending = any(p.get('symbol') == sym for p in self.sim.pending_sl_evaluations)
        if has_on_sym or has_pending:
            bar = m5.iloc[idx]
            m5_slice = m5.iloc[max(0, idx - 120):idx + 1]
            try:
                self.sim.process_candle(sym, bar, m5_slice)
            except Exception as e:
                print(f"[live-sim] process_candle error on {sym} at {t}: {e}", flush=True)

        # 2. Look for a new signal on this pair at this bar.
        t_key = int(t.timestamp())
        signal_data = self.pair_data[sym]['signal_by_time'].get(t_key)
        if signal_data is None:
            return
        self._try_open_trade(sym, idx, t, signal_data)

    def _try_open_trade(
        self,
        sym: str,
        idx: int,
        t: pd.Timestamp,
        signal_data: Dict[str, Any],
    ) -> None:
        # Live rule: at most one open position per symbol at a time.
        if any(p['symbol'] == sym for p in self.sim.open_positions):
            return

        sig = copy.deepcopy(signal_data['raw_signal'])
        m5 = self.pair_data[sym]['m5_df']

        # 1. Pair-settings filter (applied live and here, identical code path).
        strat_rr = GLOBAL_PARAMS.target_rr
        strat_be = self.use_be
        if self.pair_settings:
            strat_s = get_strategy_settings(self.pair_settings, sym, sig.strategy)

            try:
                atr14_val = float(m5.iloc[idx]['atr_14'])
                if not math.isfinite(atr14_val):
                    atr14_val = 0.0
            except Exception:
                atr14_val = 0.0

            asset_spread = ASSETS.get(sym, {}).get('spread', 0.0)
            try:
                t_dt = t.to_pydatetime() if hasattr(t, 'to_pydatetime') else t
            except Exception:
                t_dt = None

            try:
                passes, reason = passes_signal_filters(
                    strat_s, sig, t_dt, atr14_val, asset_spread,
                )
            except Exception:
                passes, reason = True, ''

            if not passes:
                sast = t.tz_convert(TZ_SAST) if hasattr(t, 'tz_convert') else t
                self.pair_setting_skips.append({
                    'time': t.strftime('%Y-%m-%d %H:%M:%S') if hasattr(t, 'strftime') else str(t),
                    'date_sast': sast.strftime('%Y-%m-%d') if hasattr(sast, 'strftime') else '',
                    'symbol': sym,
                    'strategy': sig.strategy,
                    'direction': sig.direction,
                    'reason': reason,
                    'hour_sast': int(sast.hour) if hasattr(sast, 'hour') else 0,
                })
                return

            strat_rr = get_effective_rr(strat_s, GLOBAL_PARAMS.target_rr)
            strat_be = get_effective_be(strat_s, self.use_be)

        # 2. Adaptive volatility adaptation (identical to live and to research).
        if self.adaptive_mode:
            active_vol = signal_data.get('active_vol') or {}
            if not active_vol.get('valid', False):
                return
            session_levels = signal_data.get('session_levels') or {}
            try:
                adapted = volatility_engine.adapt_signal(
                    sig, active_vol, strat_rr, session_levels,
                )
            except Exception:
                return
            if not adapted:
                return

            spread = ASSETS.get(sym, {}).get('spread', 0.0001)
            sl_dist = abs(adapted.entry_price - adapted.stop_loss)
            tp_dist = abs(adapted.take_profit_2 - adapted.entry_price)
            try:
                vol_ok, _ = volatility_engine.evaluate_volatility_filters(
                    active_vol, spread, sl_dist, tp_dist,
                    adapted.direction, adapted.entry_price, adapted.strategy,
                )
            except Exception:
                vol_ok = False
            if not vol_ok:
                return

            sig = adapted

        # 3. Open the trade. open_trade enforces the daily cap and min-lot checks.
        try:
            t_dt = t.to_pydatetime() if hasattr(t, 'to_pydatetime') else t
        except Exception:
            return

        self.sim.open_trade(
            sig,
            t_dt,
            signal_data.get('adr_val'),
            signal_data.get('regime', 'NORMAL') or 'NORMAL',
            signal_data.get('session_levels') or {},
            use_breakeven_override=strat_be,
        )

    def _close_all_at_end(self) -> None:
        for sym, data in self.pair_data.items():
            if any(p['symbol'] == sym for p in self.sim.open_positions):
                last_bar = data['m5_df'].iloc[-1]
                try:
                    self.sim.close_all(sym, last_bar)
                except Exception as e:
                    print(f"[live-sim] close_all error on {sym}: {e}", flush=True)
        # Any remaining pending post-exit trackers are finalised once.
        try:
            for pending in self.sim.pending_sl_evaluations:
                self.sim._finalize_post_exit(pending)
        except Exception:
            pass
        self.sim.pending_sl_evaluations = []

    # ------------------------------------------------------------------
    # Report builders
    # ------------------------------------------------------------------

    def _build_equity_curve(self) -> List[Dict[str, Any]]:
        curve = [{
            'trade_n': 0,
            'time': '',
            'equity': round(self.balance_usd, 2),
        }]
        eq = self.balance_usd
        ordered = sorted(
            self.sim.completed_trades,
            key=lambda tr: str(tr.get('exit_time', '')),
        )
        for i, tr in enumerate(ordered, 1):
            eq += float(tr.get('money_pnl', 0.0) or 0.0)
            curve.append({
                'trade_n': i,
                'time': tr.get('exit_time', ''),
                'equity': round(eq, 2),
            })
        return curve

    def _build_daily_equity(self) -> List[Dict[str, Any]]:
        by_day: Dict[str, List[Dict[str, Any]]] = {}
        for tr in self.sim.completed_trades:
            day = tr.get('date_sast') or ''
            if not day:
                continue
            by_day.setdefault(day, []).append(tr)

        daily: List[Dict[str, Any]] = []
        eq = self.balance_usd
        for day in sorted(by_day.keys()):
            day_trades = by_day[day]
            open_eq = eq
            day_pnl = sum(float(t.get('money_pnl', 0.0) or 0.0) for t in day_trades)
            eq += day_pnl
            daily.append({
                'date': day,
                'open_equity': round(open_eq, 2),
                'close_equity': round(eq, 2),
                'pnl': round(day_pnl, 2),
                'trades': len(day_trades),
            })
        return daily

    def _build_per_pair(self) -> Dict[str, Dict[str, Any]]:
        per: Dict[str, Dict[str, Any]] = {}
        for sym in self.pair_data.keys():
            sym_trades = [
                tr for tr in self.sim.completed_trades if tr.get('symbol') == sym
            ]
            if not sym_trades:
                per[sym] = {
                    'trades': 0,
                    'wins': 0,
                    'losses': 0,
                    'breakeven': 0,
                    'net_pnl': 0.0,
                    'win_rate': 0.0,
                    'profit_factor': 0.0,
                }
                continue

            wins = [tr for tr in sym_trades if tr.get('result') == 'WIN']
            losses = [tr for tr in sym_trades if tr.get('result') == 'LOSS']
            bes = [tr for tr in sym_trades if tr.get('result') == 'BREAKEVEN']

            gross_win = sum(float(tr.get('money_pnl', 0.0) or 0.0) for tr in wins)
            gross_loss = abs(sum(float(tr.get('money_pnl', 0.0) or 0.0) for tr in losses))
            net = sum(float(tr.get('money_pnl', 0.0) or 0.0) for tr in sym_trades)
            pf = (gross_win / gross_loss) if gross_loss > 0 else (99.0 if gross_win > 0 else 0.0)
            wr = (len(wins) / len(sym_trades)) * 100.0

            per[sym] = {
                'trades': len(sym_trades),
                'wins': len(wins),
                'losses': len(losses),
                'breakeven': len(bes),
                'net_pnl': round(net, 2),
                'win_rate': round(wr, 1),
                'profit_factor': round(pf, 2),
            }
        return per

    def _build_skip_summary(self) -> Dict[str, Any]:
        combined = list(self.sim.skipped) + self.pair_setting_skips
        by_reason: Dict[str, int] = {}
        by_pair: Dict[str, int] = {}
        by_strategy: Dict[str, int] = {}

        for s in combined:
            r = str(s.get('reason', 'UNKNOWN'))
            by_reason[r] = by_reason.get(r, 0) + 1
            p = str(s.get('symbol', 'UNKNOWN'))
            by_pair[p] = by_pair.get(p, 0) + 1
            st = str(s.get('strategy', 'UNKNOWN'))
            by_strategy[st] = by_strategy.get(st, 0) + 1

        return {
            'total': len(combined),
            'by_reason': by_reason,
            'by_pair': by_pair,
            'by_strategy': by_strategy,
        }

    def _build_report(self) -> Dict[str, Any]:
        trades = list(self.sim.completed_trades)
        kpis = calculate_kpis(trades)
        final_equity = float(self.sim.balance)

        ordered = sorted(trades, key=lambda tr: str(tr.get('signal_time_utc', '')))

        # Longest consecutive loss streak
        max_loss_streak = 0
        cur = 0
        for tr in ordered:
            if tr.get('result') == 'LOSS':
                cur += 1
                if cur > max_loss_streak:
                    max_loss_streak = cur
            else:
                cur = 0

        # Peak drawdown on the trade-level equity curve
        eq = self.balance_usd
        peak = eq
        max_dd = 0.0
        for tr in ordered:
            eq += float(tr.get('money_pnl', 0.0) or 0.0)
            if eq > peak:
                peak = eq
            dd = peak - eq
            if dd > max_dd:
                max_dd = dd

        net_pnl = final_equity - self.balance_usd
        net_pct = (net_pnl / self.balance_usd * 100.0) if self.balance_usd > 0 else 0.0

        wins_count = sum(1 for tr in trades if tr.get('result') == 'WIN')
        losses_count = sum(1 for tr in trades if tr.get('result') == 'LOSS')
        be_count = sum(1 for tr in trades if tr.get('result') == 'BREAKEVEN')

        return {
            'combo_label': self.combo_label,
            'mode': self.combo.get('mode', 'adaptive'),
            'be': self.combo.get('be', 'off'),
            'trail': self.combo.get('trail', 'off'),
            'rr_override': self.rr_override,

            'starting_balance_usd': round(self.balance_usd, 2),
            'final_equity': round(final_equity, 2),
            'net_pnl': round(net_pnl, 2),
            'net_pnl_pct': round(net_pct, 2),
            'peak_drawdown': round(max_dd, 2),
            'max_consecutive_losses': max_loss_streak,

            'total_trades': len(trades),
            'wins': wins_count,
            'losses': losses_count,
            'breakeven': be_count,
            'win_rate': kpis.get('win_rate', 0.0),
            'profit_factor': kpis.get('profit_factor', 0.0),
            'expectancy_r': kpis.get('expectancy', 0.0),
            'max_dd_money': kpis.get('max_dd_money', 0.0),

            'per_pair': self._build_per_pair(),
            'equity_curve': self._build_equity_curve(),
            'daily_equity': self._build_daily_equity(),
            'all_trades': trades,
            'skip_summary': self._build_skip_summary(),
        }


# ----------------------------------------------------------------------
# Data loading helper
# ----------------------------------------------------------------------

def _load_pair_for_live_sim(
    sym: str,
    days_count: int,
) -> Optional[Dict[str, Any]]:
    """
    Load one pair's M5 data, compute indicators and fetch its precompute
    cache. Returns None when data or cache is missing. Never raises.
    """
    m5_path = os.path.join(DATA_DIR, f"{sym}_M5.csv")
    if not os.path.exists(m5_path):
        print(f"[live-sim] {sym}: missing M5 file, skipping.", flush=True)
        return None

    try:
        m5_df = pd.read_csv(m5_path)
        m5_df['time'] = pd.to_datetime(m5_df['time'], utc=True)
    except Exception as e:
        print(f"[live-sim] {sym}: could not load M5 ({e}).", flush=True)
        return None

    if m5_df.empty:
        print(f"[live-sim] {sym}: M5 file is empty, skipping.", flush=True)
        return None

    compute_121_window_emas(m5_df)
    compute_atr14_series(m5_df)

    last_bar = m5_df['time'].iloc[-1]
    cutoff = last_bar - pd.Timedelta(days=int(days_count))
    mask = (m5_df['time'] >= cutoff).to_numpy()
    if not mask.any():
        print(f"[live-sim] {sym}: no bars in window, skipping.", flush=True)
        return None
    sim_start_idx = max(120, int(mask.argmax()))

    cached = _try_load_precompute(sym, sim_start_idx, len(m5_df))
    if cached is None:
        print(
            f"[live-sim] {sym}: no precompute cache for this window. "
            f"Run a Strategy Research backtest first (same number of days).",
            flush=True,
        )
        return None

    cached_signals = cached.get('cached_signals') or {}
    signal_by_time: Dict[int, Dict[str, Any]] = {}
    for i, sig_data in cached_signals.items():
        try:
            t = m5_df['time'].iloc[i]
        except Exception:
            continue
        signal_by_time[int(t.timestamp())] = sig_data

    print(
        f"[live-sim] {sym}: loaded, {len(cached_signals)} signals in cache.",
        flush=True,
    )

    return {
        'm5_df': m5_df,
        'sim_start_idx': sim_start_idx,
        'cached_signals': cached_signals,
        'signal_by_time': signal_by_time,
        'total_bars': len(m5_df),
    }


# ----------------------------------------------------------------------
# Public entry point
# ----------------------------------------------------------------------

async def run_live_portfolio_simulation(
    symbols_list: List[str],
    days_count: int,
    starting_balance_input: float,
    currency: str,
    zar_rate: float,
    profile_name: str,
) -> bool:
    """
    Run the Live Bot Portfolio Replay across the given symbols and every
    combination. Writes live_sim_report.json into OUTPUT_DIR.

    Returns True on success, False on any fatal error.
    """
    currency = (currency or 'USD').upper()
    if currency == 'ZAR' and zar_rate and zar_rate > 0:
        usd_balance = max(1.0, float(starting_balance_input) / float(zar_rate))
    else:
        usd_balance = max(1.0, float(starting_balance_input))

    print(
        f"[live-sim] Starting balance: {starting_balance_input} {currency} "
        f"-> ${usd_balance:.2f} USD",
        flush=True,
    )

    pair_data: Dict[str, Dict[str, Any]] = {}
    for sym in symbols_list:
        loaded = _load_pair_for_live_sim(sym, days_count)
        if loaded is not None:
            pair_data[sym] = loaded

    if not pair_data:
        print(
            "[live-sim] No pairs available. Run a Strategy Research backtest first "
            "with the same number of days.",
            flush=True,
        )
        return False

    pair_settings = load_pair_settings()

    combo_reports: List[Dict[str, Any]] = []
    run_started = time.perf_counter()

    for combo in COMBINATIONS:
        print(f"[live-sim] Running {combo['label']} ...", flush=True)
        combo_t0 = time.perf_counter()
        try:
            sim = LivePortfolioSimulator(
                combo=combo,
                balance_usd=usd_balance,
                profile_name=profile_name,
                pair_data=pair_data,
                zar_per_usd=zar_rate,
                pair_settings=pair_settings,
            )
            report = sim.run()
            report['run_seconds'] = round(time.perf_counter() - combo_t0, 2)
            combo_reports.append(report)
            print(
                f"[live-sim] {combo['label']}: "
                f"{report['total_trades']} trades, "
                f"net ${report['net_pnl']}, "
                f"final ${report['final_equity']}, "
                f"{report['run_seconds']}s",
                flush=True,
            )
        except Exception as e:
            import traceback
            print(f"[live-sim] Combo {combo['label']} failed: {e}", flush=True)
            traceback.print_exc()
            combo_reports.append({
                'combo_label': combo.get('label', 'Unknown'),
                'error': str(e),
                'run_seconds': round(time.perf_counter() - combo_t0, 2),
            })

    total_seconds = round(time.perf_counter() - run_started, 2)

    output = {
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC'),
        'days': int(days_count),
        'symbols': list(pair_data.keys()),
        'starting_balance_input': float(starting_balance_input),
        'currency': currency,
        'zar_per_usd': float(zar_rate),
        'profile_name': profile_name,
        'starting_balance_usd': round(usd_balance, 2),
        'total_seconds': total_seconds,
        'combos': combo_reports,
    }

    out_file = os.path.join(OUTPUT_DIR, 'live_sim_report.json')
    try:
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        safe = sanitize_for_json(output)
        tmp = out_file + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(safe, f, separators=(',', ':'), allow_nan=False)
        os.replace(tmp, out_file)
        print(f"[live-sim] Wrote {out_file} ({total_seconds}s total).", flush=True)
        return True
    except Exception as e:
        print(f"[live-sim] Failed to write report: {e}", flush=True)
        return False
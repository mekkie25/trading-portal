"""
tests/test_deal_replay.py
PROPOSED (Step 3 of deal-replay fix).

Verifies that historical deals replayed from the broker (sync_deals_from_ctrader)
do NOT contaminate live risk state, and that rebuild_period_counters_from_history
rebuilds day/week/month loss counters from the journal at startup.

Rules covered:
1. A loss from 60 days ago changes nothing in record_trade_outcome_scoped.
2. A loss that closed today but BEFORE _bot_started_at_utc changes nothing.
3. A loss that closed AFTER _bot_started_at_utc updates daily/weekly/monthly
   loss AND the consecutive_losses streak.
4. rebuild ignores a 60-day-old loss but counts one from now.
5. Missing / empty trades_db.json gives all-zero counters and no crash.
6. Running rebuild twice gives identical numbers.

All file paths are under tmp_path. Windows-safe.
"""

import sys
import os
import json
import pytest
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import risk.risk_manager as rm_mod
from risk.risk_manager import RiskManager, get_sast_session_date
from core.session_config import TZ_SAST


def _make_rm(monkeypatch, tmp_path, trades_rows=None, bot_started_utc=None):
    """
    Builds a RiskManager pointed entirely at tmp_path. Writes trades_db.json if
    rows are given. Uses pytest's monkeypatch so the module-level path stays
    patched for the entire test body (not just during construction).
    """
    trades_path = tmp_path / "trades_db.json"
    state_path = tmp_path / "state.json"
    config_path = tmp_path / "bot_config.json"

    if trades_rows is not None:
        trades_path.write_text(json.dumps(trades_rows), encoding="utf-8")

    monkeypatch.setattr(rm_mod, "TRADES_DB_FILE", str(trades_path))

    rm = RiskManager(config_file=str(config_path), state_file=str(state_path))
    if bot_started_utc is not None:
        rm._bot_started_at_utc = bot_started_utc
    return rm


def _iso_utc(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------------------
# 1. Old loss from 60 days ago -> scoped changes nothing.
# ---------------------------------------------------------------------------
def test_scoped_ignores_deal_older_than_startup(tmp_path, monkeypatch):
    started = datetime.now(timezone.utc)
    rm = _make_rm(monkeypatch, tmp_path, trades_rows=[], bot_started_utc=started)

    closed_at = started - timedelta(days=60)
    changed = rm.record_trade_outcome_scoped(-5.00, closed_at)

    assert changed is False
    assert rm.current_daily_loss == 0.0
    assert rm.current_weekly_loss == 0.0
    assert rm.current_monthly_loss == 0.0
    assert rm.today_closed_profit == 0.0
    assert rm.consecutive_losses == 0
    assert rm.expected_balance == 0.0


# ---------------------------------------------------------------------------
# 2. Loss closed today but BEFORE startup -> scoped changes nothing.
# ---------------------------------------------------------------------------
def test_scoped_ignores_loss_before_startup_today(tmp_path, monkeypatch):
    started = datetime.now(timezone.utc) - timedelta(hours=1)
    rm = _make_rm(monkeypatch, tmp_path, trades_rows=[], bot_started_utc=started)

    closed_at = datetime.now(timezone.utc) - timedelta(hours=3)
    changed = rm.record_trade_outcome_scoped(-3.00, closed_at)

    assert changed is False
    assert rm.current_daily_loss == 0.0
    assert rm.current_weekly_loss == 0.0
    assert rm.current_monthly_loss == 0.0
    assert rm.today_closed_profit == 0.0
    assert rm.consecutive_losses == 0
    assert rm.expected_balance == 0.0


# ---------------------------------------------------------------------------
# 3. Loss closed AFTER startup -> all counters update, streak increments.
# ---------------------------------------------------------------------------
def test_scoped_counts_loss_after_startup(tmp_path, monkeypatch):
    started = datetime.now(timezone.utc) - timedelta(hours=2)
    rm = _make_rm(monkeypatch, tmp_path, trades_rows=[], bot_started_utc=started)

    closed_at = datetime.now(timezone.utc) - timedelta(minutes=30)
    changed = rm.record_trade_outcome_scoped(-4.00, closed_at)

    assert changed is True
    assert abs(rm.current_daily_loss - 4.00) < 1e-9
    assert abs(rm.current_weekly_loss - 4.00) < 1e-9
    assert abs(rm.current_monthly_loss - 4.00) < 1e-9
    assert rm.consecutive_losses == 1
    assert abs(rm.expected_balance + 4.00) < 1e-9


# ---------------------------------------------------------------------------
# 4. rebuild ignores a 60-day-old loss but counts one from now.
# ---------------------------------------------------------------------------
def test_rebuild_counts_only_in_window(tmp_path, monkeypatch):
    now_utc = datetime.now(timezone.utc)
    sast_now = now_utc.astimezone(TZ_SAST)

    old_close = _iso_utc(now_utc - timedelta(days=60))
    recent_close = _iso_utc(sast_now - timedelta(minutes=5))

    rows = [
        {"id": "deal-old",    "ticket": "#OLD1", "closeTime": old_close,    "pnl": -99.00},
        {"id": "deal-recent", "ticket": "#REC1", "closeTime": recent_close, "pnl": -7.50},
    ]
    rm = _make_rm(monkeypatch, tmp_path, trades_rows=rows)
    rm.rebuild_period_counters_from_history()

    assert abs(rm.current_daily_loss - 7.50) < 1e-9
    assert abs(rm.current_weekly_loss - 7.50) < 1e-9
    assert abs(rm.current_monthly_loss - 7.50) < 1e-9


# ---------------------------------------------------------------------------
# 5. Missing / empty trades_db.json -> all-zero, no crash.
# ---------------------------------------------------------------------------
def test_rebuild_missing_file_zeroes_counters(tmp_path, monkeypatch):
    rm = _make_rm(monkeypatch, tmp_path, trades_rows=None)
    rm.current_daily_loss = 11.11
    rm.current_weekly_loss = 22.22
    rm.current_monthly_loss = 33.33
    rm.today_closed_profit = 44.44

    rm.rebuild_period_counters_from_history()

    assert rm.current_daily_loss == 0.0
    assert rm.current_weekly_loss == 0.0
    assert rm.current_monthly_loss == 0.0
    assert rm.today_closed_profit == 0.0


def test_rebuild_empty_file_zeroes_counters(tmp_path, monkeypatch):
    trades_path = tmp_path / "trades_db.json"
    trades_path.write_text("", encoding="utf-8")

    monkeypatch.setattr(rm_mod, "TRADES_DB_FILE", str(trades_path))

    rm = RiskManager(
        config_file=str(tmp_path / "bot_config.json"),
        state_file=str(tmp_path / "state.json"),
    )
    rm.current_daily_loss = 5.00
    rm.rebuild_period_counters_from_history()
    assert rm.current_daily_loss == 0.0


# ---------------------------------------------------------------------------
# 6. Running rebuild twice gives the same numbers.
# ---------------------------------------------------------------------------
def test_rebuild_is_idempotent(tmp_path, monkeypatch):
    now_utc = datetime.now(timezone.utc)
    rows = [
        {"id": "deal-a", "ticket": "#A", "closeTime": _iso_utc(now_utc - timedelta(minutes=10)), "pnl": -3.00},
        {"id": "deal-b", "ticket": "#B", "closeTime": _iso_utc(now_utc - timedelta(minutes=5)),  "pnl": -2.00},
    ]
    rm = _make_rm(monkeypatch, tmp_path, trades_rows=rows)

    rm.rebuild_period_counters_from_history()
    first_day = rm.current_daily_loss
    first_week = rm.current_weekly_loss
    first_month = rm.current_monthly_loss

    rm.rebuild_period_counters_from_history()

    assert rm.current_daily_loss == first_day
    assert rm.current_weekly_loss == first_week
    assert rm.current_monthly_loss == first_month
    assert abs(first_day - 5.00) < 1e-9
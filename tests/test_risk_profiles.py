"""
trading-portal/tests/test_risk_profiles.py
Unit tests verifying Step 2 Risk Profiles behavior:
1. Profile unset gives exact legacy / old behavior (clamped to 2% max ceiling).
2. Cap per band matches specification across Steady, Balanced, Aggressive, and Max Growth.
3. Max Growth under R500 uses 35% cap.
4. House money limit: Extra risk only uses up to 50% of today's closed profit.
5. Circuit breaker daily allowance limit: Trade risk cannot exceed remaining daily allowance.
6. AI multiplier safety: Clamped to 1.0 or below (never raises risk).
"""

import sys
import os
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from risk.risk_manager import RiskManager, RISK_PROFILES, convert_equity_to_zar


def test_profile_unset_gives_old_behavior():
    rm = RiskManager(config_file="nonexistent.json", state_file="/tmp/test_unset.json")
    rm.active_profile = None
    rm.risk_per_trade_pct = 5.0  # Above 2% ceiling

    # Old behavior clamps to max_risk_per_trade_pct (2.0%)
    risk_pct = rm.combined_risk_pct(current_equity=1000.0, dow_mult=1.0, ai_factor=1.0)
    assert risk_pct == 2.0


def test_cap_per_band_max_growth_under_500():
    rm = RiskManager(config_file="nonexistent.json", state_file="/tmp/test_max_growth.json")
    rm.active_profile_name = "Max Growth"
    rm.active_profile = RISK_PROFILES["Max Growth"]
    rm.starting_day_equity = 20.0

    # $20 USD * 18 = R360 (< R500) -> 35% cap
    risk_pct = rm.combined_risk_pct(current_equity=20.0, dow_mult=1.0, ai_factor=1.0, account_currency="USD", usd_zar_rate=18.0)
    assert risk_pct == 35.0


def test_cap_per_band_steady_balanced_aggressive():
    rm = RiskManager(config_file="nonexistent.json", state_file="/tmp/test_bands.json")
    rm.starting_day_equity = 10000.0

    # R1500 (Band 1: 500-2000)
    rm.active_profile = RISK_PROFILES["Steady"]
    assert rm._get_profile_band_risk_pct(rm.active_profile, zar_equity=1500.0) == 3.0

    rm.active_profile = RISK_PROFILES["Balanced"]
    assert rm._get_profile_band_risk_pct(rm.active_profile, zar_equity=1500.0) == 6.0

    rm.active_profile = RISK_PROFILES["Aggressive"]
    assert rm._get_profile_band_risk_pct(rm.active_profile, zar_equity=1500.0) == 15.0

    rm.active_profile = RISK_PROFILES["Max Growth"]
    assert rm._get_profile_band_risk_pct(rm.active_profile, zar_equity=1500.0) == 25.0


def test_house_money_limited_to_50_pct_closed_profit():
    rm = RiskManager(config_file="nonexistent.json", state_file="/tmp/test_house_money.json")
    rm.active_profile_name = "Steady"
    rm.active_profile = RISK_PROFILES["Steady"]
    rm.starting_day_equity = 1000.0  # R18,000 -> Steady band 3: 1.5% = $15 base risk

    # With 0 profit today, base risk is $15 (1.5%)
    rm.today_closed_profit = 0.0
    risk_pct_no_profit = rm.combined_risk_pct(current_equity=1000.0, dow_mult=1.0, ai_factor=1.0, account_currency="USD")
    assert risk_pct_no_profit == 1.5

    # With $10 closed profit today, 50% house money = +$5 (allows up to $20 risk, bounded by tier cap)
    rm.today_closed_profit = 10.0
    risk_pct_with_profit = rm.combined_risk_pct(current_equity=1000.0, dow_mult=1.0, ai_factor=1.0, account_currency="USD")
    assert risk_pct_with_profit == 1.5  # Bounded by profile tier cap


def test_trade_risk_cannot_exceed_remaining_daily_allowance():
    rm = RiskManager(config_file="nonexistent.json", state_file="/tmp/test_daily_allowance.json")
    rm.active_profile_name = "Balanced"
    rm.active_profile = RISK_PROFILES["Balanced"]  # Daily stop: 15% = $150 on $1000 equity
    rm.starting_day_equity = 1000.0

    # Suppose daily loss already reached $140. Only $10 remaining daily allowance!
    rm.current_daily_loss = 140.0
    risk_pct = rm.combined_risk_pct(current_equity=860.0, dow_mult=1.0, ai_factor=1.0, account_currency="USD")

    # Trade risk in cash cannot exceed $10 -> (10 / 860) * 100 = ~1.16%
    assert risk_pct == pytest.approx((10.0 / 860.0) * 100.0, rel=1e-2)


def test_ai_multiplier_clamped_to_1_or_below():
    rm = RiskManager(config_file="nonexistent.json", state_file="/tmp/test_ai_clamp.json")
    rm.active_profile_name = "Steady"
    rm.active_profile = RISK_PROFILES["Steady"]
    rm.starting_day_equity = 1000.0

    # Even if AI outputs 1.5x, safe clamp ensures it cannot raise risk above 1.0x
    risk_pct = rm.combined_risk_pct(current_equity=1000.0, dow_mult=1.0, ai_factor=1.5, account_currency="USD")
    assert risk_pct == 1.5  # Exactly 1.5% base band risk, not 2.25%

def test_profile_steady_caps_daily_trades_even_with_higher_bot_config(tmp_path, monkeypatch):
    """
    PROPOSED (Gap 5): InstitutionalRiskEngine.sync_ui_config must NOT let
    bot_config's maxDailyTrades override the profile's cap. With Steady (2 trades)
    selected and bot_config saying 4, the engine must keep 2.
    """
    import json
    import engine.matrix as matrix_mod
    import risk.risk_manager as rm_mod

    # Redirect the runtime state file so the test doesn't touch the real repo.
    monkeypatch.setattr(rm_mod.RiskManager, "save_persistent_state", lambda self: None)

    cfg_path = tmp_path / "bot_config.json"
    cfg_path.write_text(json.dumps({
        "masterExecution": True,
        "riskProfile": "Steady",
        "maxDailyTrades": 4,
    }), encoding="utf-8")

    # read_ui_config() resolves CONFIG_FILE at call time, so patch the module-level name.
    monkeypatch.setattr(matrix_mod, "CONFIG_FILE", str(cfg_path))

    engine = matrix_mod.InstitutionalRiskEngine(config_file=str(cfg_path))
    engine.sync_ui_config()

    assert engine.max_daily_trades == 2, (
        f"Expected Steady profile cap (2) but got {engine.max_daily_trades}. "
        "bot_config.json's maxDailyTrades=4 leaked through."
    )


def test_profile_unset_respects_bot_config_daily_trades(tmp_path, monkeypatch):
    """
    PROPOSED (Gap 5) regression guard: with riskProfile null, the old behaviour
    must hold — bot_config's maxDailyTrades is applied verbatim.
    """
    import json
    import engine.matrix as matrix_mod
    import risk.risk_manager as rm_mod

    monkeypatch.setattr(rm_mod.RiskManager, "save_persistent_state", lambda self: None)

    cfg_path = tmp_path / "bot_config.json"
    cfg_path.write_text(json.dumps({
        "masterExecution": True,
        "riskProfile": None,
        "maxDailyTrades": 4,
    }), encoding="utf-8")

    monkeypatch.setattr(matrix_mod, "CONFIG_FILE", str(cfg_path))

    engine = matrix_mod.InstitutionalRiskEngine(config_file=str(cfg_path))
    engine.sync_ui_config()

    assert engine.max_daily_trades == 4, (
        f"Expected legacy behaviour (4) but got {engine.max_daily_trades}. "
        "riskProfile=null must leave bot_config's maxDailyTrades in effect."
    )

def test_profile_steady_caps_daily_trades_even_with_higher_bot_config(tmp_path, monkeypatch):
    """Gap 5: profile Steady (2 trades) must win over bot_config's 4."""
    import json
    import engine.matrix as matrix_mod
    import risk.risk_manager as rm_mod

    monkeypatch.setattr(rm_mod.RiskManager, "save_persistent_state", lambda self: None)

    cfg_path = tmp_path / "bot_config.json"
    cfg_path.write_text(json.dumps({
        "masterExecution": True,
        "riskProfile": "Steady",
        "maxDailyTrades": 4,
    }), encoding="utf-8")
    monkeypatch.setattr(matrix_mod, "CONFIG_FILE", str(cfg_path))

    engine = matrix_mod.InstitutionalRiskEngine(config_file=str(cfg_path))
    engine.sync_ui_config()
    assert engine.max_daily_trades == 2


def test_profile_unset_respects_bot_config_daily_trades(tmp_path, monkeypatch):
    """Gap 5 regression: profile null keeps bot_config's 4."""
    import json
    import engine.matrix as matrix_mod
    import risk.risk_manager as rm_mod

    monkeypatch.setattr(rm_mod.RiskManager, "save_persistent_state", lambda self: None)

    cfg_path = tmp_path / "bot_config.json"
    cfg_path.write_text(json.dumps({
        "masterExecution": True,
        "riskProfile": None,
        "maxDailyTrades": 4,
    }), encoding="utf-8")
    monkeypatch.setattr(matrix_mod, "CONFIG_FILE", str(cfg_path))

    engine = matrix_mod.InstitutionalRiskEngine(config_file=str(cfg_path))
    engine.sync_ui_config()
    assert engine.max_daily_trades == 4


def test_min_rr_floor_steady_raises_ui_value(tmp_path, monkeypatch):
    """Gap 3: Steady floor 1.0 beats UI 0.5."""
    import json
    import engine.matrix as matrix_mod
    import risk.risk_manager as rm_mod
    from core.session_config import GLOBAL_PARAMS

    monkeypatch.setattr(rm_mod.RiskManager, "save_persistent_state", lambda self: None)

    cfg_path = tmp_path / "bot_config.json"
    cfg_path.write_text(json.dumps({
        "masterExecution": True,
        "riskProfile": "Steady",
        "minRr": 0.5,
        "maxDailyTrades": 4,
    }), encoding="utf-8")
    monkeypatch.setattr(matrix_mod, "CONFIG_FILE", str(cfg_path))

    engine = matrix_mod.InstitutionalRiskEngine(config_file=str(cfg_path))
    engine.sync_ui_config()
    assert abs(GLOBAL_PARAMS.min_rr - 1.0) < 1e-9


def test_min_rr_floor_aggressive_raises_ui_value(tmp_path, monkeypatch):
    """Gap 3: Aggressive floor 2.0 beats UI 1.5."""
    import json
    import engine.matrix as matrix_mod
    import risk.risk_manager as rm_mod
    from core.session_config import GLOBAL_PARAMS

    monkeypatch.setattr(rm_mod.RiskManager, "save_persistent_state", lambda self: None)

    cfg_path = tmp_path / "bot_config.json"
    cfg_path.write_text(json.dumps({
        "masterExecution": True,
        "riskProfile": "Aggressive",
        "minRr": 1.5,
        "maxDailyTrades": 4,
    }), encoding="utf-8")
    monkeypatch.setattr(matrix_mod, "CONFIG_FILE", str(cfg_path))

    engine = matrix_mod.InstitutionalRiskEngine(config_file=str(cfg_path))
    engine.sync_ui_config()
    assert abs(GLOBAL_PARAMS.min_rr - 2.0) < 1e-9


def test_min_rr_ui_higher_than_floor_wins(tmp_path, monkeypatch):
    """Gap 3: UI 3.0 beats Aggressive floor 2.0; profile null keeps UI value."""
    import json
    import engine.matrix as matrix_mod
    import risk.risk_manager as rm_mod
    from core.session_config import GLOBAL_PARAMS

    monkeypatch.setattr(rm_mod.RiskManager, "save_persistent_state", lambda self: None)

    cfg_path = tmp_path / "bot_config.json"
    cfg_path.write_text(json.dumps({
        "masterExecution": True,
        "riskProfile": "Aggressive",
        "minRr": 3.0,
        "maxDailyTrades": 4,
    }), encoding="utf-8")
    monkeypatch.setattr(matrix_mod, "CONFIG_FILE", str(cfg_path))

    engine = matrix_mod.InstitutionalRiskEngine(config_file=str(cfg_path))
    engine.sync_ui_config()
    assert abs(GLOBAL_PARAMS.min_rr - 3.0) < 1e-9

    cfg_path.write_text(json.dumps({
        "masterExecution": True,
        "riskProfile": None,
        "minRr": 0.7,
        "maxDailyTrades": 4,
    }), encoding="utf-8")

    engine2 = matrix_mod.InstitutionalRiskEngine(config_file=str(cfg_path))
    engine2.sync_ui_config()
    assert abs(GLOBAL_PARAMS.min_rr - 0.7) < 1e-9
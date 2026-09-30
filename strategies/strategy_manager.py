"""
trading-portal/strategies/strategy_manager.py
Orchestrates institutional quantitative strategies across the 7 whitelisted assets,
passing multi-timeframe market feeds (M5, H1, H4, D1) and selecting the highest-confidence
setup among all permitted strategies (eliminating first-match short-circuiting).
"""

import os
import json
import logging
import inspect
from typing import List, Optional
from strategies.base import StrategySignal
from strategies.grubber_kick import GrubberKick
from strategies.strategy_513_cross import Strategy513
from strategies.orb_liquidity_sweep_reversal import ORBLiquiditySweep
from strategies.avwap_200ema_trend_continuation import AVWAPTrendContinuation
from strategies.pdh_pdl_failed_breakout import LiquidityTrap
from strategies.ema_9_25_cross_trail import EMACrossTrail
from strategies.orb_cracker_counter_sweep import ORBCracker
from strategies.oes_4h_order_block_retest import OrderBlockRetest

log = logging.getLogger("StrategyManager")
CONFIG_FILE = "bot_config.json"

class StrategyManager:
    ALLOWED_ASSETS = {
        "GOLD": "frxXAUUSD",
        "US30": "OTC_DJI",
        "NAS100": "OTC_NDX",
        "GERMAN30": "OTC_GDAXI",
        "EURUSD": "frxEURUSD",
        "USDJPY": "frxUSDJPY",
        "GBPUSD": "frxGBPUSD"
    }

    STRATEGY_PERMITTED_ASSETS = {
        "GRUBBER_KICK": {"US30"},
        "STRATEGY_513": {"GOLD", "US30", "NAS100", "GERMAN30", "EURUSD", "USDJPY", "GBPUSD"},
        "ORB_LIQUIDITY_SWEEP": {"GOLD", "US30", "NAS100", "GERMAN30", "EURUSD", "GBPUSD"},
        "AVWAP_200EMA_CONTINUATION": {"GOLD", "US30", "NAS100", "GERMAN30"},
        "PDH_PDL_FAILED_BREAKOUT": {"GOLD", "US30", "NAS100", "GERMAN30", "EURUSD", "GBPUSD"},
        "EMA_9_25_CROSS": {"GOLD", "EURUSD", "USDJPY", "GBPUSD"},
        "ORB_CRACKER": {"NAS100", "US30", "GOLD"},
        "OES_4H_ORDER_BLOCK": {"GOLD", "US30", "NAS100", "GERMAN30", "EURUSD", "USDJPY", "GBPUSD"}
    }

    def __init__(self):
        self.strategies = [
            GrubberKick(),
            Strategy513(),
            ORBLiquiditySweep(),
            AVWAPTrendContinuation(),
            LiquidityTrap(),
            EMACrossTrail(),
            ORBCracker(),
            OrderBlockRetest()
        ]

    def _get_strategy_modes(self) -> dict:
        if not os.path.exists(CONFIG_FILE):
            return {}
        try:
            with open(CONFIG_FILE, "r") as f:
                cfg = json.load(f)
            return cfg.get("strategyModes", {})
        except Exception:
            return {}

    def evaluate_all(self, symbol: str, data_5m, data_h4, data_d1, session_levels: dict, data_h1=None) -> StrategySignal | None:
        """
        Evaluates ALL strategies for the symbol. Rather than stopping at the first match,
        it collects all valid signals and selects the one with the highest confidence score.
        """
        if symbol not in self.ALLOWED_ASSETS:
            return None

        strategy_modes = self._get_strategy_modes()
        valid_signals: List[StrategySignal] = []

        for strat in self.strategies:
            strat_name = strat.__class__.__name__
            try:
                sig = inspect.signature(strat.evaluate)
                params = sig.parameters
                kwargs = {}
                if 'data_h4' in params: kwargs['data_h4'] = data_h4
                if 'data_d1' in params: kwargs['data_d1'] = data_d1
                if 'session_levels' in params: kwargs['session_levels'] = session_levels
                if 'data_h1' in params: kwargs['data_h1'] = data_h1

                signal = strat.evaluate(symbol, data_5m, **kwargs)

                if signal:
                    # 1. Enforce strict asset boundary
                    permitted = self.STRATEGY_PERMITTED_ASSETS.get(signal.strategy, set())
                    if signal.symbol not in permitted:
                        continue

                    # 2. Enforce 3-Way Mode Switch (LIVE | DRY_RUN | OFF)
                    mode = strategy_modes.get(signal.strategy, "LIVE")
                    if mode == "OFF":
                        continue

                    if mode == "DRY_RUN":
                        setattr(signal, "is_dry_run", True)
                    else:
                        setattr(signal, "is_dry_run", False)

                    valid_signals.append(signal)

            except Exception as e:
                log.error(f"Error evaluating {strat_name} on {symbol}: {e}")
                continue

        if not valid_signals:
            return None

        # Return the highest-confidence setup (A+ setup prioritization)
        best_signal = max(valid_signals, key=lambda s: getattr(s, 'confidence', 0.80))
        if len(valid_signals) > 1:
            log.info(f"Multiple signals generated for {symbol} ({[s.strategy for s in valid_signals]}). Selected highest confidence: {best_signal.strategy} ({best_signal.confidence})")

        return best_signal
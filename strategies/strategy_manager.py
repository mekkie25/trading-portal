"""
strategies/strategy_manager.py
Orchestrates institutional quantitative strategies across the 7 whitelisted assets,
passing multi-timeframe market feeds (M5, H4, D1) and enforcing the 3-Way Mode Switch.
"""
import os
import json
import logging
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

    def evaluate_all(self, symbol: str, data_5m, data_h4, data_d1, session_levels: dict) -> StrategySignal | None:
        if symbol not in self.ALLOWED_ASSETS:
            return None

        strategy_modes = self._get_strategy_modes()

        for strat in self.strategies:
            try:
                # Check if strategy accepts multi-timeframe arguments
                import inspect
                sig = inspect.signature(strat.evaluate)
                if len(sig.parameters) >= 5:
                    signal = strat.evaluate(symbol, data_5m, data_h4, data_d1, session_levels)
                else:
                    signal = strat.evaluate(symbol, data_5m, session_levels)

                if signal:
                    permitted = self.STRATEGY_PERMITTED_ASSETS.get(signal.strategy, set())
                    if signal.symbol not in permitted:
                        continue

                    mode = strategy_modes.get(signal.strategy, "LIVE")
                    if mode == "OFF":
                        continue
                    
                    if mode == "DRY_RUN":
                        setattr(signal, "is_dry_run", True)
                    else:
                        setattr(signal, "is_dry_run", False)

                    return signal
            except Exception as e:
                log.error(f"Error evaluating {strat.__class__.__name__} on {symbol}: {e}")
                continue

        return None
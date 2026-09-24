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

class StrategyManager:
    """
    Orchestrates the 8 quantitative strategies across the 7 strictly whitelisted assets.
    """
    # Strict Asset Whitelist - Nothing else can be traded
    ALLOWED_ASSETS = {
        "GOLD": "frxXAUUSD",
        "US30": "US30",
        "NAS100": "NAS100",
        "GERMAN30": "GERMAN30",
        "EURUSD": "frxEURUSD",
        "USDJPY": "frxUSDJPY",
        "GBPUSD": "frxGBPUSD"
    }

    # Strict Asset Matrix per Strategy
    STRATEGY_PERMITTED_ASSETS = {
        "GRUBBER_KICK": {"US30"},  # Strictly US30 only!
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

    def evaluate_all(self, symbol: str, data_5m, session_levels: dict) -> StrategySignal | None:
        if symbol not in self.ALLOWED_ASSETS:
            return None

        for strat in self.strategies:
            try:
                signal: StrategySignal | None = strat.evaluate(symbol, data_5m, session_levels)
                if signal:
                    # Enforce asset boundary
                    permitted = self.STRATEGY_PERMITTED_ASSETS.get(signal.strategy, set())
                    if signal.symbol not in permitted:
                        log.warning(f"Rejected signal {signal.strategy} on disallowed asset {signal.symbol}")
                        continue
                    
                    return signal
            except Exception as e:
                log.error(f"Error evaluating {strat.__class__.__name__} on {symbol}: {e}")
                continue

        return None
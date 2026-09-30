"""
trading-portal/strategies/base.py
Institutional Strategy Signal Base Interface & Rich Execution Metadata.
"""

from dataclasses import dataclass
from typing import Optional, Dict, Any

@dataclass
class StrategySignal:
    strategy: str                          # e.g., "GRUBBER_KICK", "ORB_LIQUIDITY_SWEEP"
    symbol: str                            # e.g., "US30", "GOLD", "NAS100"
    direction: str                         # "BUY" or "SELL"
    entry_price: float
    stop_loss: float
    take_profit: float                     # Master target
    take_profit_1: Optional[float] = None  # Scale-out 50% target
    take_profit_2: Optional[float] = None  # Secondary target
    take_profit_3: Optional[float] = None  # Runner target (R2/S2)
    scale_out_fraction: float = 0.50       # Spec Section 6: Scale out 50%
    trail_mode: str = "MOVE_TO_BE_80"      # "MOVE_TO_BE_80", "SUPERTREND", "EMA_9"
    session: str = "LONDON_OR_NY"
    confidence: float = 0.85
    reason: str = ""
    is_dry_run: bool = False
    diagnostics: Optional[Dict[str, Any]] = None

    @property
    def sl(self) -> float:
        return self.stop_loss

    @property
    def tp1(self) -> float:
        return self.take_profit_1 if self.take_profit_1 is not None else self.take_profit
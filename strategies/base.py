from dataclasses import dataclass
from typing import Optional

@dataclass
class StrategySignal:
    strategy: str           # e.g., "GRUBBER_KICK", "STRATEGY_513"
    symbol: str             # e.g., "US30", "GOLD"
    direction: str          # "BUY" or "SELL"
    entry_price: float
    stop_loss: float
    take_profit: float
    take_profit_2: Optional[float] = None
    confidence: float = 0.85
    reason: str = ""
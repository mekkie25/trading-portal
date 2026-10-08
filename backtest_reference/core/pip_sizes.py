"""
core/pip_sizes.py
Single source of truth for per-symbol pip sizes.

Every module that needs to convert a price distance into pips, or to compute
pip value in account currency, must import from this file. Do not redefine
these values anywhere else in the codebase.

The values here match what is currently in:
  - backtest/simulator.py  (ASSETS["X"]["pip_size"])
  - engine/matrix.py       (ConfigManager.ASSETS["X"].pip_size)
  - backtest/diagnostics.py (used to have a local _PIP_SIZES copy)

When any of those modules is next touched, it should import from this module
instead of carrying its own copy.

Units:
  US30      1.0       one index point per pip
  GOLD      0.01      one US cent per pip
  NAS100    0.1       one tenth of an index point per pip
  GERMAN30  0.1       one tenth of an index point per pip
  EURUSD    0.0001    one hundredth of a US cent per pip
  USDJPY    0.01      one hundredth of a JPY per pip
  GBPUSD    0.0001    one hundredth of a US cent per pip
"""
from typing import Dict

PIP_SIZES: Dict[str, float] = {
    "GOLD": 0.01,
    "US30": 1.0,
    "NAS100": 0.1,
    "GERMAN30": 0.1,
    "EURUSD": 0.0001,
    "USDJPY": 0.01,
    "GBPUSD": 0.0001,
}

DEFAULT_PIP_SIZE: float = 0.0001


def get_pip_size(symbol: str) -> float:
    """Return the pip size for a friendly symbol name (case-insensitive)."""
    if not symbol:
        return DEFAULT_PIP_SIZE
    return PIP_SIZES.get(str(symbol).upper(), DEFAULT_PIP_SIZE)
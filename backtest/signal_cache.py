"""
backtest/signal_cache.py
Per-strategy signal cache keyed on each strategy's own source hash.

Design
------
Each strategy has its own cache file: {SYMBOL}_sig_{STRATEGY}.pkl.
The cache key is a hash of:
  - the strategy's own source file (found by scanning strategies/*.py for
    "class <StrategyName>")
  - strategies/base.py (StrategySignal dataclass)
  - the level store fingerprint (session_levels.py, indicators.py,
    session_config.py, and the level-affecting GLOBAL_PARAMS values)

Consequences:
  - Editing strategies/foo.py invalidates ONLY that strategy's cache.
    The other 7 strategies are read from disk as before.
  - Editing strategies/base.py invalidates every strategy cache.
  - Editing core/session_levels.py or core/indicators.py invalidates every
    strategy cache (the inputs to the strategies changed).
  - Editing strategies/strategy_manager.py does NOT invalidate anything.
  - Changing GLOBAL_PARAMS.grubber_kick_fixed_sl (or the other signal-
    affecting params listed below) invalidates every cache.
  - Disabling a strategy at runtime costs nothing; the cached signal is
    present but is dropped by the mode check.

Storage: one pickle per (symbol, strategy). Each pickle holds
  {"__hash__": ..., "__version__": 1, "signals": {epoch: StrategySignal | None}}
Only epochs where the strategy fired OR where a cache miss occurred are stored.
A cache miss is always stored, even as None, so a buggy strategy is not retried
every run. If you fix the bug, the source hash changes and the cache is
invalidated automatically.
"""

import os
import glob
import pickle
import hashlib
import tempfile
from datetime import datetime, timezone
from typing import Dict, Any, Optional, List

from backtest.paths import DATA_DIR

CACHE_VERSION = 1


def _level_store_fingerprint() -> str:
    """
    Hash of the level/indicator sources plus the signal-affecting GLOBAL_PARAMS.
    If any of these change, all strategy caches must rebuild.
    """
    h = hashlib.sha256()
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    for rel in [
        "core/session_levels.py",
        "core/indicators.py",
        "core/session_config.py",
    ]:
        p = os.path.join(project_root, rel)
        try:
            with open(p, "rb") as f:
                h.update(rel.encode())
                h.update(f.read())
        except FileNotFoundError:
            h.update(rel.encode())

    # Signal-affecting GLOBAL_PARAMS. Extend this list if a new flag ever
    # changes what a strategy.evaluate() returns.
    try:
        from core.session_config import GLOBAL_PARAMS
        for key in [
            "adaptive_mode",
            "require_cvd_absorption",
            "require_dxy_alignment",
            "grubber_kick_fixed_sl",
            "pdh_pdl_liquidity_buffer_pts",
            "value_area_pct",
        ]:
            h.update(f"{key}={getattr(GLOBAL_PARAMS, key, None)}".encode())
    except Exception:
        pass

    return h.hexdigest()[:10]


def _strategy_file_hash(strategy_name: str) -> str:
    """
    Hash of the strategy's own source file, strategies/base.py and the level
    store fingerprint. Found by scanning strategies/*.py for
    "class <StrategyName>".
    """
    h = hashlib.sha256()
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

    found = False
    for path in sorted(glob.glob(os.path.join(project_root, "strategies", "*.py"))):
        try:
            with open(path, "rb") as f:
                content = f.read()
        except OSError:
            continue
        if f"class {strategy_name}".encode() in content:
            h.update(os.path.basename(path).encode())
            h.update(content)
            found = True
            break
    if not found:
        # Strategy not on disk (e.g. an instance built ad hoc). Use its name.
        h.update(f"__missing__{strategy_name}".encode())

    try:
        with open(os.path.join(project_root, "strategies", "base.py"), "rb") as f:
            h.update(f.read())
    except OSError:
        pass

    h.update(_level_store_fingerprint().encode())
    return h.hexdigest()[:16]


def _cache_path(symbol: str, strategy_name: str) -> str:
    return os.path.join(DATA_DIR, f"{symbol}_sig_{strategy_name}.pkl")


def load_strategy_cache(symbol: str, strategy_name: str) -> Optional[Dict[int, Any]]:
    """
    Return {epoch: signal_or_None} if the cache exists and matches the current
    hash, else None.
    """
    path = _cache_path(symbol, strategy_name)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "rb") as f:
            payload = pickle.load(f)
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("__version__") != CACHE_VERSION:
        return None
    if payload.get("__hash__") != _strategy_file_hash(strategy_name):
        return None
    signals = payload.get("signals")
    if not isinstance(signals, dict):
        return None
    return signals


def save_strategy_cache(symbol: str, strategy_name: str, signals: Dict[int, Any]) -> bool:
    """Write the cache atomically. Returns True on success."""
    path = _cache_path(symbol, strategy_name)
    payload = {
        "__hash__": _strategy_file_hash(strategy_name),
        "__version__": CACHE_VERSION,
        "__saved_at__": datetime.now(timezone.utc).isoformat(),
        "__count__": len(signals),
        "signals": signals,
    }
    try:
        dirname = os.path.dirname(path)
        fd, tmp = tempfile.mkstemp(dir=dirname, prefix="tmp_sig_", suffix=".pkl")
        with os.fdopen(fd, "wb") as f:
            pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)
        os.replace(tmp, path)
        return True
    except Exception as e:
        print(f"[signal_cache] {symbol}/{strategy_name}: write failed: {e}", flush=True)
        return False


def strategy_cache_status(symbol: str, strategy_name: str) -> Dict[str, Any]:
    """Status for the storage strip and the panel."""
    path = _cache_path(symbol, strategy_name)
    current_hash = _strategy_file_hash(strategy_name)
    if not os.path.exists(path):
        return {"has_cache": False, "matches": False, "hash": current_hash}
    try:
        size_mb = os.path.getsize(path) / (1024 * 1024)
    except OSError:
        size_mb = 0.0
    try:
        with open(path, "rb") as f:
            payload = pickle.load(f)
        matches = (payload.get("__hash__") == current_hash and
                   payload.get("__version__") == CACHE_VERSION)
        count = int(payload.get("__count__", 0))
    except Exception:
        matches = False
        count = 0
    return {
        "has_cache": True,
        "matches": matches,
        "hash": current_hash,
        "size_mb": round(size_mb, 3),
        "entry_count": count,
    }


def list_cached_strategies(symbol: str) -> List[str]:
    """Return the strategy names that have a cache file for this symbol."""
    pattern = os.path.join(DATA_DIR, f"{symbol}_sig_*.pkl")
    out = []
    for p in glob.glob(pattern):
        name = os.path.basename(p)
        if name.startswith(f"{symbol}_sig_"):
            out.append(name[len(f"{symbol}_sig_"):-len(".pkl")])
    return sorted(out)


def delete_stale_caches(symbol: str, keep_strategies: List[str]) -> int:
    """Delete any cache file for this symbol not in keep_strategies. Returns count deleted."""
    deleted = 0
    for name in list_cached_strategies(symbol):
        if name not in keep_strategies:
            try:
                os.remove(_cache_path(symbol, name))
                deleted += 1
            except OSError:
                pass
    return deleted
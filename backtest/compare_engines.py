"""
backtest/compare_engines.py
Runs the frozen old engine (in backtest_reference/) and the current engine on
the same window, then reports the first stage where their trades diverge.

Run as a subprocess:
    python backtest/compare_engines.py --symbol US30 --days 60
Writes backtest/output/{SYMBOL}_compare.json.

Neither engine runs in-process here. Both are spawned as subprocesses so their
module imports cannot collide. Each engine reads and writes its own files.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

REFERENCE_DIR = os.path.join(PROJECT_ROOT, 'backtest_reference')
REFERENCE_BACKTEST_DIR = os.path.join(REFERENCE_DIR, 'backtest')
REFERENCE_SIMULATOR = os.path.join(REFERENCE_BACKTEST_DIR, 'simulator.py')

# The two combos we compare. Old: Adaptive · BE on · Trail off. New: BE on · R:R 1:1.
OLD_COMBO_FILENAME = "{symbol}_adaptive_beon_trailoff_report.json"
NEW_COMBO_FILENAME = "{symbol}_adaptive_beon_rr1.1_report.json"
OLD_COMBO_LABEL = "Adaptive · BE on · Trail off"
NEW_COMBO_LABEL = "BE on · R:R 1:1"


def _find_python() -> str:
    return 'python' if os.name == 'nt' else 'python3'


def _storage_paths() -> Dict[str, str]:
    storage = (os.getenv("BACKTEST_STORAGE_DIR") or "").strip()
    if storage:
        return {
            "data": os.path.join(storage, "data"),
            "output": os.path.join(storage, "output"),
        }
    return {
        "data": os.path.join(PROJECT_ROOT, "backtest", "data"),
        "output": os.path.join(PROJECT_ROOT, "backtest", "output"),
    }


def _reference_paths() -> Dict[str, str]:
    # The old paths.py also honours BACKTEST_STORAGE_DIR, so the effective
    # data/output directories are the same as the current ones when that env
    # var is set. Otherwise they are relative to backtest_reference/.
    storage = (os.getenv("BACKTEST_STORAGE_DIR") or "").strip()
    if storage:
        return {
            "data": os.path.join(storage, "data"),
            "output": os.path.join(storage, "output"),
        }
    return {
        "data": os.path.join(REFERENCE_BACKTEST_DIR, "data"),
        "output": os.path.join(REFERENCE_BACKTEST_DIR, "output"),
    }


def _ensure_reference_present() -> Optional[str]:
    if not os.path.isdir(REFERENCE_DIR):
        return f"Reference folder missing: {REFERENCE_DIR}"
    if not os.path.exists(os.path.join(REFERENCE_BACKTEST_DIR, "runner.py")):
        return "Reference runner missing: backtest_reference/backtest/runner.py"
    if not os.path.isdir(os.path.join(REFERENCE_DIR, "strategies")):
        return "Reference strategies missing: backtest_reference/strategies/"
    return None


def _copy_csvs_for_reference(symbol: str) -> List[str]:
    """Make sure the old engine can find the M5/H1/H4/D1 CSVs."""
    src_dir = _storage_paths()["data"]
    dst_dir = _reference_paths()["data"]
    if os.path.abspath(src_dir) == os.path.abspath(dst_dir):
        return []
    os.makedirs(dst_dir, exist_ok=True)
    copied = []
    for tf in ("M5", "H1", "H4", "D1"):
        src = os.path.join(src_dir, f"{symbol}_{tf}.csv")
        dst = os.path.join(dst_dir, f"{symbol}_{tf}.csv")
        if os.path.exists(src):
            shutil.copy2(src, dst)
            copied.append(tf)
    return copied


def _run_engine(cwd: str, symbol: str, days: int, timeout: int = 900) -> Dict[str, Any]:
    py = _find_python()
    cmd = [py, "backtest/runner.py", "--symbol", symbol, "--days", str(days), "--skip-download"]
    env = os.environ.copy()
    if os.path.abspath(cwd) == os.path.abspath(REFERENCE_DIR):
        env["PYTHONPATH"] = REFERENCE_DIR + os.pathsep + env.get("PYTHONPATH", "")
    try:
        proc = subprocess.run(
            cmd, cwd=cwd, env=env,
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"error": f"Timed out after {timeout}s", "stdout_tail": "", "stderr_tail": ""}
    return {
        "exit_code": proc.returncode,
        "stdout_tail": "\n".join(proc.stdout.splitlines()[-15:]),
        "stderr_tail": "\n".join(proc.stderr.splitlines()[-15:]),
        "error": None if proc.returncode == 0 else f"Exited with code {proc.returncode}",
    }


def _read_report(output_dir: str, filename: str) -> Optional[Dict[str, Any]]:
    path = os.path.join(output_dir, filename)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _normalise_trade(t: Dict[str, Any]) -> Dict[str, Any]:
    """Return the fields we compare, using the same names for both engines."""
    return {
        "signal_time_utc": t.get("signal_time_utc"),
        "direction": t.get("direction"),
        "strategy": t.get("strategy"),
        "entry_price": t.get("entry_price"),
        "sl": t.get("sl"),
        "tp": t.get("tp"),
        "exit_time": t.get("exit_time"),
        "exit_price": t.get("exit_price"),
        "exit_reason": t.get("exit_reason"),
        "money_pnl": t.get("money_pnl"),
    }


def _diff_trades(old_trades: List[Dict[str, Any]], new_trades: List[Dict[str, Any]], max_samples: int = 5) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    n = max(len(old_trades), len(new_trades))
    for idx in range(n):
        if idx >= len(old_trades):
            out.append({"index": idx, "stage": "EXTRA_IN_NEW", "new": _normalise_trade(new_trades[idx])})
            if len(out) >= max_samples:
                break
            continue
        if idx >= len(new_trades):
            out.append({"index": idx, "stage": "MISSING_IN_NEW", "old": _normalise_trade(old_trades[idx])})
            if len(out) >= max_samples:
                break
            continue
        o = old_trades[idx]
        nw = new_trades[idx]
        stage = None
        if (o.get("signal_time_utc") != nw.get("signal_time_utc")
                or o.get("strategy") != nw.get("strategy")
                or o.get("direction") != nw.get("direction")):
            stage = "SIGNAL"
        elif abs((o.get("entry_price") or 0) - (nw.get("entry_price") or 0)) > 1e-4:
            stage = "ENTRY"
        elif (abs((o.get("sl") or 0) - (nw.get("sl") or 0)) > 1e-4
              or abs((o.get("tp") or 0) - (nw.get("tp") or 0)) > 1e-4):
            stage = "STOP_OR_TARGET"
        elif (o.get("exit_time") != nw.get("exit_time")
              or abs((o.get("exit_price") or 0) - (nw.get("exit_price") or 0)) > 1e-4):
            stage = "EXIT"
        elif o.get("exit_reason") != nw.get("exit_reason"):
            stage = "EXIT_REASON"
        elif abs((o.get("money_pnl") or 0) - (nw.get("money_pnl") or 0)) > 1e-2:
            stage = "PNL"
        if stage is not None:
            out.append({
                "index": idx,
                "stage": stage,
                "old": _normalise_trade(o),
                "new": _normalise_trade(nw),
            })
            if len(out) >= max_samples:
                break
    return out


def _read_kpis(report: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not report:
        return None
    k = report.get("global_kpis") or {}
    return {
        "count": k.get("count"),
        "win_rate": k.get("win_rate"),
        "profit_factor": k.get("profit_factor"),
        "net_pnl": k.get("net_pnl"),
        "max_dd_money": k.get("max_dd_money"),
    }


def _extract_old_cost_assumptions(symbol: str) -> Optional[Dict[str, Any]]:
    if not os.path.exists(REFERENCE_SIMULATOR):
        return None
    try:
        with open(REFERENCE_SIMULATOR, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return None
    pattern = re.compile(r'"' + re.escape(symbol) + r'"\s*:\s*\{([^}]+)\}')
    m = pattern.search(content)
    if not m:
        return None
    body = m.group(1)
    out: Dict[str, Any] = {}
    for kv in body.split(","):
        if ":" not in kv:
            continue
        k, v = kv.split(":", 1)
        k = k.strip().strip('"').strip("'")
        v = v.strip().rstrip(",")
        try:
            out[k] = float(v)
        except ValueError:
            out[k] = v.strip('"').strip("'")
    # Collision rule: read from the simulator source
    out["collision_rule"] = "SL_CONSERVATIVE_COLLISION" if "SL_CONSERVATIVE_COLLISION" in content else "UNKNOWN"
    # Commission / slippage: look for the words
    out["has_commission"] = "commission" in content.lower()
    out["has_slippage"] = "slippage" in content.lower()
    return out


def _extract_current_cost_assumptions(symbol: str) -> Optional[Dict[str, Any]]:
    try:
        from backtest.simulator import ASSETS as CURRENT_ASSETS
    except Exception:
        return None
    cfg = CURRENT_ASSETS.get(symbol)
    if not cfg:
        return None
    out = dict(cfg)
    try:
        with open(os.path.join(PROJECT_ROOT, "backtest", "simulator.py"), "r", encoding="utf-8") as f:
            content = f.read()
        out["collision_rule"] = "SL_CONSERVATIVE_COLLISION" if "SL_CONSERVATIVE_COLLISION" in content else "UNKNOWN"
        out["has_commission"] = "commission" in content.lower()
        out["has_slippage"] = "slippage" in content.lower()
    except Exception:
        pass
    return out


def run_comparison(symbol: str, days: int) -> Dict[str, Any]:
    err = _ensure_reference_present()
    if err:
        return {
            "symbol": symbol,
            "days": days,
            "error": err,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        }

    copied = _copy_csvs_for_reference(symbol)

    old_paths = _reference_paths()
    new_paths = _storage_paths()
    old_filename = OLD_COMBO_FILENAME.format(symbol=symbol)
    new_filename = NEW_COMBO_FILENAME.format(symbol=symbol)

    # Remove stale outputs so a cached read cannot lie.
    for p in [os.path.join(old_paths["output"], old_filename),
              os.path.join(new_paths["output"], new_filename)]:
        if os.path.exists(p):
            try:
                os.remove(p)
            except OSError:
                pass

    old_run = _run_engine(REFERENCE_DIR, symbol, days)
    new_run = _run_engine(PROJECT_ROOT, symbol, days)

    old_report = _read_report(old_paths["output"], old_filename)
    new_report = _read_report(new_paths["output"], new_filename)

    old_trades = (old_report or {}).get("all_trades", []) if old_report else []
    new_trades = (new_report or {}).get("all_trades", []) if new_report else []

    divergences = _diff_trades(old_trades, new_trades, max_samples=5) if (old_trades or new_trades) else []

    return {
        "symbol": symbol,
        "days": days,
        "old_combo": OLD_COMBO_LABEL,
        "new_combo": NEW_COMBO_LABEL,
        "csv_copied": copied,
        "old_run": old_run,
        "new_run": new_run,
        "old_trades_count": len(old_trades),
        "new_trades_count": len(new_trades),
        "old_kpis": _read_kpis(old_report),
        "new_kpis": _read_kpis(new_report),
        "divergences_count": len(divergences),
        "divergences_sample": divergences,
        "verdict": "IDENTICAL" if len(divergences) == 0 else f"{len(divergences)}+ DIFFERENCES",
        "cost_assumptions": {
            "old": _extract_old_cost_assumptions(symbol),
            "new": _extract_current_cost_assumptions(symbol),
        },
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
    }


def _write_result(symbol: str, payload: Dict[str, Any]) -> str:
    out_dir = _storage_paths()["output"]
    os.makedirs(out_dir, exist_ok=True)
    out_file = os.path.join(out_dir, f"{symbol}_compare.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, allow_nan=False, default=str)
    return out_file


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", type=str, required=True)
    parser.add_argument("--days", type=int, default=60)
    args = parser.parse_args()

    symbol = args.symbol.upper()
    print(f"[COMPARE] {symbol}: starting comparison over {args.days} days...", flush=True)
    payload = run_comparison(symbol, args.days)
    out_file = _write_result(symbol, payload)
    print(f"[COMPARE] {symbol}: saved {out_file}", flush=True)
    print(f"[COMPARE] {symbol}: verdict {payload.get('verdict')}", flush=True)
    sys.exit(0 if "error" not in payload else 1)


if __name__ == "__main__":
    main()
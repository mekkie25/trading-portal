"""
trading-portal/strategies/base.py
Institutional Strategy Signal Base Interface & Adaptive Range-Projection Engine.
"""

import logging
from dataclasses import dataclass
from typing import Optional, Dict, Any

try:
    from config.strategy_params import GLOBAL_PARAMS
except ImportError:
    from core.session_config import GLOBAL_PARAMS

log = logging.getLogger("StrategyBase")


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
    reference_range_height: Optional[float] = None  # Height of reference range (ORB, Asia, PDH-PDL)
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


def adapt_signal(
    signal: StrategySignal,
    vol_metrics: Dict[str, Any],
    ui_rr: float,
    session_levels: Dict[str, Any],
    min_rr: Optional[float] = None
) -> Optional[StrategySignal]:
    """
    Adapts signals via dynamic ADR stop-bounds and range-projection targeting:
    - Bounded Stops: Rejects if structural SL > k_max * ADR; widens if < k_min * ADR.
    - Range Projection: Projects reference range height (ORB, Asia, PDH-PDL) from entry.
    - Structural Capping: Caps targets at next structural hurdle or available ADR room.
    - Minimum R:R: Rejects setups if adapted TP2 distance delivers < min_rr.
    - Monotonicity: Enforces strict entry -> TP1 -> TP2 -> TP3 progression.
    """
    if not vol_metrics or not vol_metrics.get("valid", False):
        return None

    adr = vol_metrics["adr"]
    k_scale = vol_metrics.get("k_scale", 1.0)
    entry = signal.entry_price
    direction = signal.direction.upper()

    # 1. Weekly Open with Fallback
    weekly_open = session_levels.get("weekly_open")
    if weekly_open is None or weekly_open == 0.0:
        fallback_open = vol_metrics.get("d1_open", entry)
        log.warning(f"Missing weekly_open for {signal.symbol}; falling back to D1 open ({fallback_open}).")
        weekly_open = fallback_open

    # 2. Stop-Loss Clamping & Invalidation
    raw_k_min, _, raw_k_max = GLOBAL_PARAMS.adr_sl_ratios.get(signal.symbol, (0.10, 0.20, 0.25))
    k_min = raw_k_min * k_scale
    k_max = raw_k_max * k_scale

    structural_sl_dist = abs(entry - signal.stop_loss)
    if structural_sl_dist > (k_max * adr):
        # Trade is structurally too wide for current volatility: reject outright
        return None

    # Widen undersized stops to volatility floor
    effective_sl_dist = max(structural_sl_dist, k_min * adr)
    adapted_sl = (entry - effective_sl_dist) if direction == "BUY" else (entry + effective_sl_dist)

    # 3. Range-Projection Targeting (Target 2)
    # Determine the reference range height
    proj_dist = None
    if signal.reference_range_height and signal.reference_range_height > 0:
        proj_dist = signal.reference_range_height
    elif signal.strategy in ("ORB_LIQUIDITY_SWEEP", "ORB_CRACKER"):
        orb_h = session_levels.get("orb_high", 0.0)
        orb_l = session_levels.get("orb_low", 0.0)
        if orb_h > orb_l:
            proj_dist = orb_h - orb_l
    elif signal.strategy == "GRUBBER_KICK":
        ah = session_levels.get("asia_high", 0.0)
        al = session_levels.get("asia_low", 0.0)
        if ah > al:
            proj_dist = ah - al
    elif signal.strategy == "PDH_PDL_FAILED_BREAKOUT":
        pdh = session_levels.get("pdh", 0.0)
        pdl = session_levels.get("pdl", 0.0)
        if pdh > pdl:
            proj_dist = pdh - pdl

    # If range height is missing, use unconstrained UI R:R baseline
    if not proj_dist or proj_dist <= 0:
        proj_dist = effective_sl_dist * ui_rr

    ideal_projected_tp = (entry + proj_dist) if direction == "BUY" else (entry - proj_dist)

    # 4. Structural Capping (Pivot R1/S1, PDH/PDL, Asia H/L, VAH/VAL)
    strat_tp2 = signal.take_profit_2 or signal.take_profit
    if strat_tp2 and strat_tp2 != 0:
        if direction == "BUY":
            tp2 = min(strat_tp2, ideal_projected_tp) if strat_tp2 > entry else ideal_projected_tp
        else:
            tp2 = max(strat_tp2, ideal_projected_tp) if strat_tp2 < entry else ideal_projected_tp
    else:
        tp2 = ideal_projected_tp

    # 5. Enforce Minimum R:R Filter
    effective_min_rr = min_rr if min_rr is not None else GLOBAL_PARAMS.min_rr
    final_tp_dist = abs(tp2 - entry)
    if (final_tp_dist / effective_sl_dist) < effective_min_rr:
        # Rejection: Target cannot satisfy the minimum R:R threshold
        return None

    # 6. Intermediate Scale-Out Target (TP1)
    strat_tp1 = signal.take_profit_1
    if strat_tp1 and strat_tp1 != 0:
        tp1 = strat_tp1
    else:
        tp1 = entry + (0.50 * (tp2 - entry))

    # 7. Strict Monotonicity Check (Entry -> TP1 -> TP2)
    if direction == "BUY":
        if not (entry < tp1 < tp2):
            tp1 = entry + (0.50 * (tp2 - entry))
            if not (entry < tp1 < tp2):
                return None
    else:
        if not (entry > tp1 > tp2):
            tp1 = entry + (0.50 * (tp2 - entry))
            if not (entry > tp1 > tp2):
                return None

    # 8. Runner Evaluation (TP3): Pivot R2/S2 capped by 85% AWR
    pivot_r2_s2 = session_levels.get("pivot_r2" if direction == "BUY" else "pivot_s2")
    awr = vol_metrics.get("awr", adr * 3.5)
    weekly_cap = (weekly_open + (0.85 * awr)) if direction == "BUY" else (weekly_open - (0.85 * awr))

    if pivot_r2_s2 and pivot_r2_s2 != 0:
        candidate_tp3 = min(pivot_r2_s2, weekly_cap) if direction == "BUY" else max(pivot_r2_s2, weekly_cap)
    else:
        candidate_tp3 = (entry + (effective_sl_dist * (ui_rr + 1.0))) if direction == "BUY" else (entry - (effective_sl_dist * (ui_rr + 1.0)))

    # Invalidate runner if candidate does not expand past TP2
    if direction == "BUY" and candidate_tp3 <= tp2:
        final_tp3 = None
    elif direction == "SELL" and candidate_tp3 >= tp2:
        final_tp3 = None
    else:
        final_tp3 = round(candidate_tp3, 5)

    # Return fully adapted signal (preserves strategy trail_mode untouched)
    signal.stop_loss = round(adapted_sl, 5)
    signal.take_profit = round(tp2, 5)
    signal.take_profit_1 = round(tp1, 5)
    signal.take_profit_2 = round(tp2, 5)
    signal.take_profit_3 = final_tp3
    signal.scale_out_fraction = 0.50
    return signal
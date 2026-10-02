"""
trading-portal/core/targets.py
Pure function for fixed risk-to-reward target calculation and structural room checking.
"""

from typing import Optional, Any


def compute_fixed_target(signal: Any, target_rr: float, use_final_target: bool = False) -> Optional[float]:
    """
    Computes a fixed R:R take-profit price and verifies there is enough room:
    - stop_distance = abs(entry_price - stop_loss)
    - target = entry +/- stop_distance * target_rr (plus for BUY, minus for SELL)
    - structural_target selection:
        * if use_final_target is True: take_profit_2 if present and > 0, else take_profit (ignores take_profit_1)
        * if use_final_target is False: take_profit_1 if present, otherwise take_profit
    - if structural_target is CLOSER to entry than the fixed target, returns None (no room)
    - never modifies stop_loss
    - returns the fixed target price if room is clear
    """
    entry = float(signal.entry_price)
    sl = float(signal.stop_loss)
    direction = str(signal.direction).upper()

    stop_distance = abs(entry - sl)
    if stop_distance <= 0:
        return None

    target_distance = stop_distance * float(target_rr)

    if direction == "BUY":
        fixed_target = entry + target_distance
    elif direction == "SELL":
        fixed_target = entry - target_distance
    else:
        return None

    # Check the signal's structural target based on use_final_target flag
    if use_final_target:
        tp2 = getattr(signal, "take_profit_2", None)
        if tp2 is not None and float(tp2) > 0:
            structural_tp = tp2
        else:
            structural_tp = getattr(signal, "take_profit", None)
    else:
        structural_tp = getattr(signal, "take_profit_1", None)
        if structural_tp is None:
            structural_tp = getattr(signal, "take_profit", None)

    if structural_tp is not None:
        try:
            structural_tp_val = float(structural_tp)
            if structural_tp_val > 0:
                structural_distance = abs(entry - structural_tp_val)
                # If structural target is closer than required target_distance, reject ("no room")
                if structural_distance < (target_distance - 1e-6):
                    return None
        except (ValueError, TypeError):
            pass

    return fixed_target
"""
trading-portal/core/targets.py
Pure function for fixed risk-to-reward target calculation and structural room checking.

FIX 2026-10-12
--------------
STRUCTURAL_WALL_FRACTION dropped from 0.60 to 0.25.
The old 0.60 was rejecting almost every trade at R:R 1:2.5.
"""

STRUCTURAL_WALL_FRACTION = 0.25


def compute_fixed_target(signal, target_rr, use_final_target=False):
    entry = float(signal.entry_price)
    sl = float(signal.stop_loss)
    direction = str(signal.direction).upper()

    stop_distance = abs(entry - sl)
    if stop_distance <= 0:
        return None

    target_distance = stop_distance * float(target_rr)
    if target_distance <= 0:
        return None

    if direction == "BUY":
        fixed_target = entry + target_distance
    elif direction == "SELL":
        fixed_target = entry - target_distance
    else:
        return None

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
                wall_threshold = STRUCTURAL_WALL_FRACTION * target_distance
                if structural_distance < wall_threshold:
                    return None
        except (ValueError, TypeError):
            pass

    return fixed_target
"""
Session configurations and market timings (SAST / UTC).
Johannesburg (SAST) is UTC+2.
"""
from datetime import datetime, timezone, time

SESSION_WINDOWS = {
    "ASIA": {"start": time(1, 0), "end": time(6, 0)},       # 01:00 - 06:00 SAST
    "LONDON": {"start": time(8, 0), "end": time(10, 0)},     # 08:00 - 10:00 SAST
    "NEW_YORK": {"start": time(15, 30), "end": time(16, 30)} # 15:30 - 16:30 SAST
}

def is_in_session(current_time: datetime, session_name: str) -> bool:
    """Checks if a given datetime falls within the specified SAST window."""
    window = SESSION_WINDOWS.get(session_name.upper())
    if not window:
        return False
    t = current_time.time()
    return window["start"] <= t <= window["end"]
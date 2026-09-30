"""
core/fx.py
Pure function for conservative account-currency conversion.
Fails closed (returns None) if account currency is unknown, quote is missing, or quote > 600s stale.
"""

import logging
from typing import Dict, List, Optional, Tuple, Callable

log = logging.getLogger("FX")

# Whitelist assets mapped to their natural quote currencies
ASSET_QUOTE_CURRENCIES: Dict[str, str] = {
    "GOLD": "USD",
    "US30": "USD",
    "NAS100": "USD",
    "GERMAN30": "EUR",
    "EURUSD": "USD",
    "GBPUSD": "USD",
    "USDJPY": "JPY",
}

# Dedicated alias mapping strictly for conversion pairs (separated from strategy scan aliases)
FX_CONVERSION_ALIASES: Dict[str, List[str]] = {
    "USDZAR": ["USDZAR", "USD/ZAR", "USDZAR.spot"],
    "EURUSD": ["EURUSD", "EUR/USD"],
    "USDJPY": ["USDJPY", "USD/JPY"],
}

# Callable contract: pair string -> (bid, ask, age_seconds) or None
QuoteLookupCallable = Callable[[str], Optional[Tuple[float, float, float]]]


def get_fx_rate_to_account(
    symbol: str,
    account_currency: Optional[str],
    quote_lookup: QuoteLookupCallable
) -> Optional[float]:
    """
    Computes the conservative exchange rate multiplier to account currency.
    Conservative rule: overestimates account-currency pip value so calculated lot size is smaller.
    Returns None (failing closed to block trade) if currency is unknown, quote missing, or stale > 600s.
    """
    if not account_currency:
        log.error(f"FX Conversion Blocked: Account currency is unknown/None. Trade blocked on {symbol}.")
        return None

    quote_curr = ASSET_QUOTE_CURRENCIES.get(symbol, "USD")
    if quote_curr == account_currency:
        return 1.0

    def fetch_valid(pair: str) -> Optional[Tuple[float, float]]:
        res = quote_lookup(pair)
        if not res:
            log.error(f"FX Conversion Blocked: Live quote for {pair} not found.")
            return None
        bid, ask, age = res
        if age > 600.0:
            log.error(f"FX Conversion Blocked: {pair} quote stale ({age:.1f}s > 600s).")
            return None
        if age > 60.0:
            log.warning(f"FX Conversion Caution: {pair} quote age is {age:.1f}s.")
        return bid, ask

    # --------------------------------------------------------------------------
    # 1. USD Account
    # --------------------------------------------------------------------------
    if account_currency == "USD":
        if quote_curr == "JPY":  # USDJPY: Divide by bid to overestimate USD pip value
            q = fetch_valid("USDJPY")
            return (1.0 / q[0]) if (q and q[0] > 0) else None
        elif quote_curr == "EUR":  # GERMAN30: Multiply by ask to overestimate USD pip value
            q = fetch_valid("EURUSD")
            return q[1] if (q and q[1] > 0) else None

    # --------------------------------------------------------------------------
    # 2. ZAR Account
    # --------------------------------------------------------------------------
    elif account_currency == "ZAR":
        q_zar = fetch_valid("USDZAR")
        if not q_zar or q_zar[1] <= 0:
            return None
        usd_to_zar_ask = q_zar[1]  # Ask overestimates ZAR value

        if quote_curr == "USD":
            return usd_to_zar_ask
        elif quote_curr == "JPY":
            q_jpy = fetch_valid("USDJPY")
            return (usd_to_zar_ask / q_jpy[0]) if (q_jpy and q_jpy[0] > 0) else None
        elif quote_curr == "EUR":
            q_eur = fetch_valid("EURUSD")
            return (q_eur[1] * usd_to_zar_ask) if (q_eur and q_eur[1] > 0) else None

    # --------------------------------------------------------------------------
    # 3. EUR Account
    # --------------------------------------------------------------------------
    elif account_currency == "EUR":
        q_eur = fetch_valid("EURUSD")
        if not q_eur or q_eur[0] <= 0:
            return None
        usd_to_eur_bid = 1.0 / q_eur[0]  # Dividing by bid overestimates EUR pip value

        if quote_curr == "USD":
            return usd_to_eur_bid
        elif quote_curr == "JPY":
            q_jpy = fetch_valid("USDJPY")
            return (usd_to_eur_bid / q_jpy[0]) if (q_jpy and q_jpy[0] > 0) else None

    log.error(f"FX Conversion Blocked: Unsupported conversion ({quote_curr} to {account_currency}).")
    return None
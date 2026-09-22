export type CurrencyCode = 'USD' | 'ZAR' | 'EUR' | 'GBP';

export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  ZAR: 'R ',
  EUR: '€',
  GBP: '£',
};

export const getCurrencySymbol = (currency: string = 'USD'): string => {
  const upper = (currency || 'USD').toUpperCase();
  return CURRENCY_SYMBOLS[upper] || '$';
};

export const formatCurrency = (
  amount: number,
  currency: string = 'USD',
  decimals: number = 2
): string => {
  const sym = getCurrencySymbol(currency);
  const num = Number(amount) || 0;
  const isNegative = num < 0;
  const absFormatted = Math.abs(num).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  if (isNegative) {
    return `-${sym}${absFormatted}`;
  }
  return `${sym}${absFormatted}`;
};

export const formatCurrencyCompact = (
  amount: number,
  currency: string = 'USD'
): string => {
  const sym = getCurrencySymbol(currency);
  const num = Number(amount) || 0;
  const abs = Math.abs(num);
  let formatted = '';

  if (abs >= 1_000_000) {
    formatted = `${(num / 1_000_000).toFixed(1)}M`;
  } else if (abs >= 1_000) {
    formatted = `${(num / 1_000).toFixed(1)}k`;
  } else {
    formatted = num.toFixed(0);
  }

  return `${sym}${formatted}`;
};

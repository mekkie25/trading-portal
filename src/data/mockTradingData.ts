export interface TradeRecord {
  id: string;
  ticket: string;
  asset: string;
  strategy: string; // <-- Required strategy identification tag
  type: 'BUY' | 'SELL';
  lots: number;
  openPrice: number;
  closePrice: number;
  pnl: number;
  pnlPct: number;
  openTime: string;
  closeTime: string;
  duration: string;
  status: 'WIN' | 'LOSS' | 'BREAKEVEN';
  source: string;
}

export interface AccountInfo {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number;
  unrealizedPnl: number;
  dailyPnl: number;
  dailyPnlPct: number;
  winRate: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
}

export interface RiskLimits {
  maxDailyLoss: number;
  maxWeeklyLoss: number;
  maxMonthlyLoss: number;
  maxPositionSize: number;
  maxOpenPositions: number;
  maxDrawdownPct: number;
}

export interface AssetConfig {
  symbol: string;
  name: string;
  category: 'Forex' | 'Indices' | 'Commodities' | 'Crypto' | 'Synthetics';
  minStake: number;
  maxStake: number;
  precision: number;
  enabled: boolean;
}

export interface EconomicEvent {
  id: string;
  time: string;
  currency: string;
  event: string;
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  actual: string;
  forecast: string;
  previous: string;
  date: string;
}

export interface BrandingConfig {
  portalName: string;
  companyName: string;
  logoUrl: string;
  theme: 'dark' | 'light';
  accentColor: string;
}

export interface BrokerPreset {
  id: string;
  name: string;
  server: string;
  brokerType: 'Deriv' | 'MetaTrader5' | 'Custom';
  appId: string;
  wsUrl: string;
  environment: 'Demo' | 'Real';
}

export interface GoogleSheetsConfig {
  enabled: boolean;
  spreadsheetId: string;
  sheetName: string;
  autoSync: boolean;
  lastSyncedAt: string | null;
}

export const initialBrandingConfig: BrandingConfig = {
  portalName: 'Matrix Algorithmic Portal',
  companyName: 'Matrix Capital Trading',
  logoUrl: '/logo.svg',
  theme: 'dark',
  accentColor: '#10B981',
};

export const brokerPresets: BrokerPreset[] = [
  {
    id: 'deriv-demo',
    name: 'Deriv WebSocket Demo',
    server: 'wss://ws.derivws.com/websockets/v3',
    brokerType: 'Deriv',
    appId: '1089',
    wsUrl: 'wss://ws.derivws.com/websockets/v3?app_id=1089',
    environment: 'Demo',
  },
  {
    id: 'deriv-real',
    name: 'Deriv WebSocket Live',
    server: 'wss://ws.derivws.com/websockets/v3',
    brokerType: 'Deriv',
    appId: '1089',
    wsUrl: 'wss://ws.derivws.com/websockets/v3?app_id=1089',
    environment: 'Real',
  },
  {
    id: 'mt5-deriv-demo',
    name: 'Deriv MT5 SVG Demo',
    server: 'Deriv-Demo',
    brokerType: 'MetaTrader5',
    appId: 'mt5_demo',
    wsUrl: 'ws://localhost:8080/mt5',
    environment: 'Demo',
  },
];

export const googleSheetsConfig: GoogleSheetsConfig = {
  enabled: true,
  spreadsheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
  sheetName: 'Live_Trade_Journal',
  autoSync: true,
  lastSyncedAt: '2026-09-24 13:00:00',
};

export const initialAccountInfo: AccountInfo = {
  balance: 25000.00,
  equity: 25340.50,
  margin: 1250.00,
  freeMargin: 24090.50,
  marginLevel: 2027.24,
  unrealizedPnl: 340.50,
  dailyPnl: 580.20,
  dailyPnlPct: 2.34,
  winRate: 68.5,
  totalTrades: 42,
  winningTrades: 28,
  losingTrades: 14,
};

export const defaultRiskLimits: RiskLimits = {
  maxDailyLoss: 2500,
  maxWeeklyLoss: 6500,
  maxMonthlyLoss: 15000,
  maxPositionSize: 10,
  maxOpenPositions: 5,
  maxDrawdownPct: 5.0,
};

// Strictly Whitelisted Trading Instruments
export const allowedAssets: AssetConfig[] = [
  { symbol: 'US30', name: 'Dow Jones 30', category: 'Indices', minStake: 1, maxStake: 100, precision: 2, enabled: true },
  { symbol: 'GOLD', name: 'Gold (XAU/USD)', category: 'Commodities', minStake: 1, maxStake: 50, precision: 2, enabled: true },
  { symbol: 'NAS100', name: 'Nasdaq 100', category: 'Indices', minStake: 1, maxStake: 100, precision: 2, enabled: true },
  { symbol: 'GERMAN30', name: 'DAX 40', category: 'Indices', minStake: 1, maxStake: 100, precision: 2, enabled: true },
  { symbol: 'EURUSD', name: 'EUR / USD', category: 'Forex', minStake: 1, maxStake: 100, precision: 5, enabled: true },
  { symbol: 'USDJPY', name: 'USD / JPY', category: 'Forex', minStake: 1, maxStake: 100, precision: 3, enabled: true },
  { symbol: 'GBPUSD', name: 'GBP / USD', category: 'Forex', minStake: 1, maxStake: 100, precision: 5, enabled: true },
];

export const mockTradeHistory: TradeRecord[] = [
  {
    id: '1',
    ticket: '9841203',
    asset: 'US30',
    strategy: 'GRUBBER_KICK',
    type: 'BUY',
    lots: 1.0,
    openPrice: 46120.50,
    closePrice: 46250.00,
    pnl: 129.50,
    pnlPct: 0.28,
    openTime: '2026-09-24 08:15:00',
    closeTime: '2026-09-24 09:30:00',
    duration: '1h 15m',
    status: 'WIN',
    source: 'Deriv MT5 / Web',
  },
  {
    id: '2',
    ticket: '9841189',
    asset: 'EURUSD',
    strategy: 'STRATEGY_513',
    type: 'SELL',
    lots: 2.0,
    openPrice: 1.08500,
    closePrice: 1.08320,
    pnl: 360.00,
    pnlPct: 0.33,
    openTime: '2026-09-24 06:00:00',
    closeTime: '2026-09-24 07:45:00',
    duration: '1h 45m',
    status: 'WIN',
    source: 'Deriv MT5 / Web',
  },
  {
    id: '3',
    ticket: '9841052',
    asset: 'GOLD',
    strategy: 'ORB_LIQUIDITY_SWEEP',
    type: 'BUY',
    lots: 0.5,
    openPrice: 2640.20,
    closePrice: 2634.50,
    pnl: -285.00,
    pnlPct: -0.22,
    openTime: '2026-09-23 14:10:00',
    closeTime: '2026-09-23 14:35:00',
    duration: '25m',
    status: 'LOSS',
    source: 'Deriv MT5 / Web',
  },
  {
    id: '4',
    ticket: '9840988',
    asset: 'NAS100',
    strategy: 'AVWAP_200EMA_CONTINUATION',
    type: 'BUY',
    lots: 1.5,
    openPrice: 19820.00,
    closePrice: 19910.00,
    pnl: 135.00,
    pnlPct: 0.45,
    openTime: '2026-09-23 11:00:00',
    closeTime: '2026-09-23 13:20:00',
    duration: '2h 20m',
    status: 'WIN',
    source: 'Deriv MT5 / Web',
  },
  {
    id: '5',
    ticket: '9840810',
    asset: 'GBPUSD',
    strategy: 'EMA_9_25_CROSS',
    type: 'SELL',
    lots: 1.0,
    openPrice: 1.32100,
    closePrice: 1.32100,
    pnl: 0.00,
    pnlPct: 0.00,
    openTime: '2026-09-22 15:00:00',
    closeTime: '2026-09-22 15:40:00',
    duration: '40m',
    status: 'BREAKEVEN',
    source: 'Deriv MT5 / Web',
  },
  {
    id: '6',
    ticket: '9840744',
    asset: 'GERMAN30',
    strategy: 'PDH_PDL_FAILED_BREAKOUT',
    type: 'SELL',
    lots: 0.8,
    openPrice: 18650.00,
    closePrice: 18580.00,
    pnl: 560.00,
    pnlPct: 0.38,
    openTime: '2026-09-22 09:10:00',
    closeTime: '2026-09-22 11:15:00',
    duration: '2h 05m',
    status: 'WIN',
    source: 'Deriv MT5 / Web',
  },
  {
    id: '7',
    ticket: '9840612',
    asset: 'USDJPY',
    strategy: 'OES_4H_ORDER_BLOCK',
    type: 'BUY',
    lots: 2.0,
    openPrice: 143.500,
    closePrice: 143.200,
    pnl: -420.00,
    pnlPct: -0.29,
    openTime: '2026-09-21 16:30:00',
    closeTime: '2026-09-21 17:10:00',
    duration: '40m',
    status: 'LOSS',
    source: 'Deriv MT5 / Web',
  }
];

export const mockEconomicCalendar: EconomicEvent[] = [
  {
    id: 'cal-1',
    date: '2026-09-24',
    time: '14:30',
    currency: 'USD',
    event: 'Unemployment Claims',
    impact: 'HIGH',
    actual: '218K',
    forecast: '224K',
    previous: '222K',
  },
  {
    id: 'cal-2',
    date: '2026-09-24',
    time: '15:45',
    currency: 'USD',
    event: 'S&P Global Flash US Manufacturing PMI',
    impact: 'MEDIUM',
    actual: '47.0',
    forecast: '48.2',
    previous: '47.9',
  },
  {
    id: 'cal-3',
    date: '2026-09-25',
    time: '08:00',
    currency: 'EUR',
    event: 'German Ifo Business Climate',
    impact: 'HIGH',
    actual: '--',
    forecast: '86.5',
    previous: '86.6',
  },
  {
    id: 'cal-4',
    date: '2026-09-25',
    time: '14:30',
    currency: 'USD',
    event: 'Core PCE Price Index m/m',
    impact: 'HIGH',
    actual: '--',
    forecast: '0.2%',
    previous: '0.2%',
  },
];
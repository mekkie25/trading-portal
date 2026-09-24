import { 
  TradeRecord, 
  TopMetrics, 
  BotSettings, 
  AdvancedLimits, 
  BrokerConfig, 
  GoogleSheetsConfig, 
  SiteBrandingConfig, 
  MarketAsset, 
  CalendarDayData 
} from '../types';

// ============================================================================
// 1. INITIAL APP & BROKER METRICS
// ============================================================================

export const INITIAL_METRICS: TopMetrics = {
  netProfit: 34820.50,
  netProfitPct: 27.8,
  winRate: 68.4,
  totalTrades: 142,
  winningTrades: 97,
  losingTrades: 45,
  totalInjections: 125000,
  currentEquity: 159820.50,
  currentBalance: 157340.00,
  unrealizedPnL: 2480.50,
};

export const INITIAL_BOT_SETTINGS: BotSettings = {
  masterExecution: true,
  riskPerTradePct: 1.25,
  riskToReward: 2.5,
  maxDailyTrades: 4,
  trailingStopActive: true,
  autoBreakevenPips: 15,
  currency: 'USD',
  lastAppliedTimestamp: '09:30:00',
};

export const INITIAL_ADVANCED_LIMITS: AdvancedLimits = {
  maxDailyDrawdownPct: 3.5,
  currentDailyDrawdownPct: 0.82,
  emergencyStopThreshold: 140000,
  consecutiveLossesLimit: 3,
  currentConsecutiveLosses: 0,
  maxOpenExposureLots: 10,
  currentOpenExposureLots: 1.5,
  maxMarginUtilizationPct: 25,
  trailingDrawdownLock: true,
  breakerAction: 'HALT_PREVENT_NEW',
  breakerTriggered: false,
  maxDailyLossUsd: 2500,
  currentDailyLossUsd: 0,
  maxWeeklyLossUsd: 6500,
  currentWeeklyLossUsd: 0,
  maxMonthlyLossUsd: 15000,
  currentMonthlyLossUsd: 0,
  maxOpenPositions: 4,
  autoLiquidateAllOnTrip: false,
  activeTripScope: 'NONE',
};

export const INITIAL_BROKER_CONFIG: BrokerConfig = {
  provider: 'Deriv',
  accountNumber: 'CR8492041',
  server: 'Deriv-Server-02',
  apiToken: '',
  webhookUrl: 'https://ws.derivws.com/websockets/v3',
  connected: true,
  lastPingMs: 14,
  lastSyncTime: 'Just now',
  autoSync: true,
  syncIntervalSec: 5,
  currency: 'USD',
};

export const INITIAL_GOOGLE_SHEETS_CONFIG: GoogleSheetsConfig = {
  sheetUrlOrId: 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit',
  apiKeyOrToken: '',
  sheetTabName: 'Live_Trade_Journal',
  lastSyncTime: '2026-09-24 13:00:00',
  autoSyncEnabled: true,
};

export const INITIAL_BRANDING_CONFIG: SiteBrandingConfig = {
  siteName: 'TRADING PORTAL',
  iconType: 'chart',
  customInitials: '',
};

// ============================================================================
// 2. AUDITED TRADE JOURNAL (STRICT 7 ALLOWED ASSETS + STRATEGIES)
// ============================================================================

export const INITIAL_TRADES: TradeRecord[] = [
  {
    id: 'tr-1',
    ticket: '#8941203',
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
    source: 'Deriv Live',
  },
  {
    id: 'tr-2',
    ticket: '#8941189',
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
    source: 'Deriv Live',
  },
  {
    id: 'tr-3',
    ticket: '#8941052',
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
    source: 'Deriv Live',
  },
  {
    id: 'tr-4',
    ticket: '#8940988',
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
    source: 'Deriv Live',
  },
  {
    id: 'tr-5',
    ticket: '#8940810',
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
    source: 'Deriv Live',
  },
  {
    id: 'tr-6',
    ticket: '#8940744',
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
    source: 'Deriv Live',
  },
  {
    id: 'tr-7',
    ticket: '#8940612',
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
    source: 'Deriv Live',
  },
];

// Backwards compatibility alias
export const mockTradeHistory = INITIAL_TRADES;

// ============================================================================
// 3. DASHBOARD EQUITY TIMEFRAME TRAJECTORY DATA
// ============================================================================

export const EQUITY_TIMEFRAME_DATA: Record<string, { labels: string[]; equity: number[]; balance: number[] }> = {
  '7D': {
    labels: ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7'],
    equity: [152000, 153400, 152900, 155200, 156800, 158100, 159820],
    balance: [151000, 152000, 152000, 154500, 156000, 156000, 157340],
  },
  '30D': {
    labels: ['W1', 'W2', 'W3', 'W4'],
    equity: [142000, 147500, 153000, 159820],
    balance: [140000, 146000, 151500, 157340],
  },
  '90D': {
    labels: ['M1', 'M2', 'M3'],
    equity: [130000, 144000, 159820],
    balance: [128000, 141000, 157340],
  },
  'YTD': {
    labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'],
    equity: [100000, 108000, 115000, 122000, 131000, 138000, 145000, 152000, 159820],
    balance: [100000, 107000, 114000, 120000, 129000, 136000, 143000, 150000, 157340],
  },
  'ALL': {
    labels: ['2024', '2025', '2026'],
    equity: [50000, 105000, 159820],
    balance: [50000, 102000, 157340],
  },
};

// ============================================================================
// 4. LIVE FEED WHITELISTED ASSETS (7 ASSETS ONLY)
// ============================================================================

export const MARKET_ASSETS: MarketAsset[] = [
  { symbol: 'GOLD', tvSymbol: 'OANDA:XAUUSD', name: 'Gold (XAU/USD)', category: 'Commodities', price: 2642.50, change24h: 1.15 },
  { symbol: 'US30', tvSymbol: 'CAPITALCOM:US30', name: 'Dow Jones 30', category: 'Indices', price: 46180.00, change24h: 0.62 },
  { symbol: 'NAS100', tvSymbol: 'CAPITALCOM:NAS100', name: 'Nasdaq 100', category: 'Indices', price: 19880.00, change24h: 0.84 },
  { symbol: 'GERMAN30', tvSymbol: 'CAPITALCOM:DE40', name: 'DAX 40', category: 'Indices', price: 18620.00, change24h: -0.22 },
  { symbol: 'EURUSD', tvSymbol: 'FX:EURUSD', name: 'EUR / USD', category: 'Forex', price: 1.08450, change24h: -0.18 },
  { symbol: 'USDJPY', tvSymbol: 'FX:USDJPY', name: 'USD / JPY', category: 'Forex', price: 143.420, change24h: 0.35 },
  { symbol: 'GBPUSD', tvSymbol: 'FX:GBPUSD', name: 'GBP / USD', category: 'Forex', price: 1.32150, change24h: 0.12 },
];

// ============================================================================
// 5. ECONOMIC CALENDAR DATA (SEPTEMBER 2026)
// ============================================================================

export const CALENDAR_DATA_SEPTEMBER_2026: Record<string, CalendarDayData> = {
  '2026-09-17': {
    date: '2026-09-17',
    dayNumber: 17,
    dayOfWeek: 'Thursday',
    hasHighImpact: true,
    eventsCount: 2,
    releases: [
      {
        id: 'rel-5',
        time: '20:00 SAST',
        currency: 'USD',
        title: 'FOMC Interest Rate Decision & Statement',
        impact: 'HIGH',
        forecast: '5.00%',
        previous: '5.25%',
        coreDefinition: 'Federal Reserve Federal Funds Rate Decision and Policy Statement.',
        mentorNote: 'Watch initial pulse for liquidity sweep before taking continuation setups.',
        institutionalInsight: {
          bullishScenario: 'Rate cut beyond expectations triggers equity expansion.',
          bearishScenario: 'Hawkish pause or rhetoric creates sharp dollar injection.',
          fakeoutTrapWarning: 'Avoid entering in the first 5 minutes of release.',
          mentorExecutionStrategy: 'Wait for 15M opening range to form and trade the failed breakout.',
        },
      },
    ],
  },
  '2026-09-24': {
    date: '2026-09-24',
    dayNumber: 24,
    dayOfWeek: 'Thursday',
    hasHighImpact: true,
    eventsCount: 1,
    releases: [
      {
        id: 'rel-8',
        time: '14:30 SAST',
        currency: 'USD',
        title: 'Initial Jobless Claims',
        impact: 'HIGH',
        forecast: '218K',
        previous: '222K',
        coreDefinition: 'Weekly measure of individuals filing for state unemployment benefits.',
        institutionalInsight: {
          bullishScenario: 'Claims rising indicates labor cooling and dovish outlook.',
          bearishScenario: 'Lower claims reinforce dollar strength.',
          fakeoutTrapWarning: 'London close overlap often causes rapid pullbacks.',
          mentorExecutionStrategy: 'Focus on US30 and Gold 15M Value Area bounces.',
        },
      },
    ],
  },
};
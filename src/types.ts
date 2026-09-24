export type TabId = 
  | 'dashboard'
  | 'journal'
  | 'limits'
  | 'calendar'
  | 'live_feed'
  | 'settings';

export type ThemeMode = 'dark' | 'light';

export interface SiteBrandingConfig {
  siteName: string;
  iconType: 'chart' | 'shield' | 'bot' | 'zap' | 'gemini' | 'terminal';
  customInitials?: string;
}

export interface BrokerConfig {
  provider: 'MetaTrader 5' | 'Deriv' | 'cTrader' | 'Custom Gateway';
  accountNumber: string;
  server: string;
  apiToken: string;
  webhookUrl: string;
  connected: boolean;
  lastPingMs: number;
  lastSyncTime: string;
  autoSync: boolean;
  syncIntervalSec: number;
  currency?: 'USD' | 'ZAR' | 'EUR' | 'GBP' | string;
}

export interface GoogleSheetsConfig {
  sheetUrlOrId: string;
  apiKeyOrToken: string;
  sheetTabName: string;
  lastSyncTime: string;
  autoSyncEnabled: boolean;
}

export interface TopMetrics {
  netProfit: number;
  netProfitPct: number;
  winRate: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalInjections: number;
  currentEquity: number;
  currentBalance: number;
  unrealizedPnL: number;
}

export interface BotSettings {
  masterExecution: boolean;
  riskPerTradePct: number;
  riskToReward: number; // 1 : X (e.g. 2.5)
  maxDailyTrades: number;
  trailingStopActive: boolean;
  autoBreakevenPips: number;
  currency?: string;
  lastAppliedTimestamp?: string;
}

export interface TradeRecord {
  id: string;
  ticket: string;
  asset: string;
  strategy: string; // <-- Added strategy identification
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
  source: 'MT5 Bridge' | 'Google Sheets' | 'Manual' | string;
}

export interface AdvancedLimits {
  maxDailyDrawdownPct: number;
  currentDailyDrawdownPct: number;
  emergencyStopThreshold: number; // in $ equity level
  consecutiveLossesLimit: number;
  currentConsecutiveLosses: number;
  maxOpenExposureLots: number;
  currentOpenExposureLots: number;
  maxMarginUtilizationPct: number;
  trailingDrawdownLock: boolean;
  breakerAction: 'HALT_CLOSE_ALL' | 'HALT_PREVENT_NEW' | 'REDUCE_SIZE_50' | 'ALERT_ONLY';
  breakerTriggered: boolean;
  lastTriggerReason?: string;
  maxDailyLossUsd?: number;
  currentDailyLossUsd?: number;
  maxWeeklyLossUsd?: number;
  currentWeeklyLossUsd?: number;
  maxMonthlyLossUsd?: number;
  currentMonthlyLossUsd?: number;
  maxOpenPositions?: number;
  autoLiquidateAllOnTrip?: boolean;
  activeTripScope?: 'NONE' | 'DAY' | 'WEEK' | 'MONTH' | 'TOTAL';
  haltUntilTimestamp?: string;
}

export interface MacroRelease {
  id: string;
  time: string;
  currency: string;
  title: string;
  name?: string;
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  actual?: string;
  forecast?: string;
  previous?: string;
  coreDefinition: string;
  mentorNote?: string;
  institutionalInsight: {
    bullishScenario: string;
    bearishScenario: string;
    fakeoutTrapWarning: string;
    mentorExecutionStrategy: string;
  };
}

export interface CalendarDayData {
  date: string; // YYYY-MM-DD
  dayNumber: number;
  dayOfWeek: string;
  hasHighImpact: boolean;
  eventsCount: number;
  releases: MacroRelease[];
}

export interface MarketAsset {
  symbol: string;
  tvSymbol: string;
  name: string;
  category: 'Synthetic / Volatility' | 'Forex' | 'Commodities' | 'Indices' | 'Crypto';
  price: number;
  change24h: number;
}

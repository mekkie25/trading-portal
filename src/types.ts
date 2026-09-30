export type TabId = 
  | 'dashboard'
  | 'journal'
  | 'limits'
  | 'calendar'
  | 'live_feed'
  | 'settings';

export type ThemeMode = 'dark' | 'light';
export type StrategyExecutionMode = 'LIVE' | 'DRY_RUN' | 'OFF';

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
  minRr?: number;                          // Minimum acceptable target R:R (replaces R:R slider)
  adaptiveMode?: boolean;                  // On = Volatility Engine, Off = Legacy Fixed
  stopOnDailyGoalReached?: boolean;        // Optional toggle: auto-halt on daily target
  maxDailyTrades: number;
  trailingStopActive: boolean;
  autoBreakevenPips: number;
  currency?: string;
  lastAppliedTimestamp?: string;
  strategyModes: Record<string, StrategyExecutionMode>;
  
  // Profit Goals
  dailyGoalTarget?: number;
  weeklyGoalTarget?: number;
  monthlyGoalTarget?: number;
  weeklyDepositBaseline?: number;
}

export interface TradeRecord {
  id: string;
  ticket: string;
  asset: string;
  strategy: string;
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
  source: 'Deriv Live' | 'Simulator' | 'Manual' | string;
  isSimulated?: boolean;
}

export interface AdvancedLimits {
  maxDailyDrawdownPct: number;
  currentDailyDrawdownPct: number;
  emergencyStopThreshold: number;
  consecutiveLossesLimit: number;
  currentConsecutiveLosses: number;
  maxOpenExposureLots: number;
  currentOpenExposureLots: number;
  maxMarginUtilizationPct: number;
  trailingDrawdownLock: boolean;
  breakerAction: 'HALT_PREVENT_NEW';
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
  activeTripScope?: 'NONE' | 'DAY' | 'WEEK' | 'MONTH' | 'CURRENCY';
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
  date: string;
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
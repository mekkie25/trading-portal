export type TabId =
  | 'dashboard'
  | 'journal'
  | 'limits'
  | 'calendar'
  | 'live_feed'
  | 'settings'
  | 'backtest';

export type ThemeMode = 'dark' | 'light';
export type StrategyExecutionMode = 'LIVE' | 'DRY_RUN' | 'OFF';

export interface SiteBrandingConfig {
  siteName: string;
  iconType: 'chart' | 'shield' | 'bot' | 'zap' | 'gemini' | 'terminal';
  customInitials?: string;
}

export interface BrokerConfig {
  provider: 'MetaTrader 5' | 'Deriv' | 'cTrader' | 'Fusion Markets cTrader' | 'Custom Gateway' | string;
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

export type RiskProfileName = 'Steady' | 'Balanced' | 'Aggressive' | 'Max Growth';

export interface BotSettings {
  masterExecution: boolean;
  riskPerTradePct: number;
  minRr?: number;
  adaptiveMode?: boolean;
  stopOnDailyGoalReached?: boolean;
  maxDailyTrades: number;
  trailingStopActive: boolean;
  autoBreakevenPips: number;
  currency?: string;
  lastAppliedTimestamp?: string;
  strategyModes: Record<string, StrategyExecutionMode>;

  dailyGoalTarget?: number;
  weeklyGoalTarget?: number;
  monthlyGoalTarget?: number;
  weeklyDepositBaseline?: number;

  riskProfile?: RiskProfileName | null;
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
  useProfileDrawdownPct?: boolean;
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

export interface BacktestKPIs {
  count: number;
  win_rate: number;
  avg_r: number;
  expectancy: number;
  profit_factor: number;
  max_dd_money: number;
  avg_duration: number;
  best_r: number;
  worst_r: number;
  net_pnl: number;
  is_inconclusive: boolean;
}

export interface BacktestDayLevels {
  asia_high?: number;
  asia_low?: number;
  daily_eq?: number;
  daily_pivot?: number;
  pdh?: number;
  pdl?: number;
  orb_high?: number;
  orb_low?: number;
}

export interface BacktestCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface BacktestDayData {
  candles: BacktestCandle[];
  trades: any[];
  levels: BacktestDayLevels;
}

export interface ImprovementTip {
  id: string;
  strategy: string;
  category: string;
  severity: 'HIGH' | 'MEDIUM' | 'INFO';
  title: string;
  description: string;
  action: string;
}

// PROPOSED: Blueprint Phase-1 + Phase-2 diagnostics (backtest/diagnostics.py).
export interface DiagnosticKPIs {
  count: number;
  win_rate: number;
  expectancy: number;
  profit_factor: number;
  net_pnl: number;
}

export interface BacktestDiagnostics {
  version?: string;
  // Phase 1
  hour_kpis: Record<string, DiagnosticKPIs>;
  session_rollover: {
    in_transition: DiagnosticKPIs;
    out_of_transition: DiagnosticKPIs;
  };
  atr_tier_kpis: Record<string, DiagnosticKPIs>;
  streak_analysis: {
    max_consecutive_losses: number;
    average_streak: number;
    streak_count: number;
    recovery_trades_from_peak_dd: number;
    peak_drawdown: number;
  };
  circuit_breaker_sim: {
    original_net_pnl: number;
    simulated_net_pnl: number;
    trades_halved: number;
    protection_delta: number;
  };
  outlier_removal: {
    full: DiagnosticKPIs;
    trimmed: DiagnosticKPIs;
    outlier_count: number;
    impact_pct: number;
  };
  monte_carlo: {
    iterations: number;
    median_max_dd: number;
    p5_max_dd: number;
    p95_max_dd: number;
    median_final_equity: number;
    prob_positive: number;
  };
  buy_and_hold: {
    first_close: number;
    last_close: number;
    bh_return_pct: number;
    bh_net_pnl: number;
    strategy_net_pnl: number;
    alpha: number;
    verdict: string;
  };
  // Phase 2
  post_sl: {
    count: number;
    mean_pips: number;
    median_pips: number;
    max_pips: number;
    recovered_count: number;
    recovered_pct: number;
  };
  post_tp: {
    count: number;
    mean_pips: number;
    median_pips: number;
    max_pips: number;
    avg_missed_r: number;
  };
  premature_be: {
    total_be_moved: number;
    premature_count: number;
    premature_pct: number;
    total_missed_r: number;
    avg_missed_r: number;
  };
  ema_200_alignment: {
    aligned: DiagnosticKPIs;
    counter_trend: DiagnosticKPIs;
    unknown: DiagnosticKPIs;
  };
  confirmation_type: {
    close: DiagnosticKPIs;
    touch: DiagnosticKPIs;
  };
  news_window: {
    in_news: DiagnosticKPIs;
    out_of_news: DiagnosticKPIs;
  };
}

export interface BacktestReportPayload {
  symbol: string;
  mode: string;
  global_kpis: BacktestKPIs;
  strategy_kpis: Record<string, BacktestKPIs>;
  dow_kpis: Record<string, BacktestKPIs>;
  trading_dates: string[];
  day_data: Record<string, BacktestDayData>;
  all_trades: any[];
  improvement_tips?: ImprovementTip[];
  tune_validate?: any;
  strategy_tune_validate?: Record<string, any>;
  // PROPOSED: Blueprint Phase-1 + Phase-2 diagnostics block.
  diagnostics?: BacktestDiagnostics;
}
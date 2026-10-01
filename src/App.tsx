import React, { useState, useEffect, useCallback } from 'react';
import { HeaderClocks } from './components/HeaderClocks';
import { Sidebar } from './components/Sidebar';
import { DashboardView } from './components/views/DashboardView';
import { TradeJournalView } from './components/views/TradeJournalView';
import { AdvancedLimitsView } from './components/views/AdvancedLimitsView';
import { EconomicCalendarView } from './components/views/EconomicCalendarView';
import { LiveFeedView } from './components/views/LiveFeedView';
import { SettingsView } from './components/views/SettingsView';
import { BacktestView } from './components/views/BacktestView';
import { BrokerVsCodeBridgeModal } from './components/BrokerVsCodeBridgeModal';

import { 
  INITIAL_BOT_SETTINGS, 
  INITIAL_ADVANCED_LIMITS, 
  INITIAL_BROKER_CONFIG, 
  INITIAL_GOOGLE_SHEETS_CONFIG, 
  INITIAL_BRANDING_CONFIG 
} from './data/mockTradingData';
import { 
  TabId, 
  TopMetrics, 
  BotSettings, 
  AdvancedLimits, 
  TradeRecord, 
  ThemeMode, 
  BrokerConfig, 
  GoogleSheetsConfig, 
  SiteBrandingConfig 
} from './types';

const safeStorage = {
  getItem: <T,>(key: string, fallback: T): T => {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : fallback;
    } catch {
      return fallback;
    }
  },
  setItem: (key: string, value: unknown): void => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

function recalculateLedgerMetrics(tradesList: TradeRecord[], prev: TopMetrics): TopMetrics {
  const safeList = Array.isArray(tradesList) ? tradesList : [];
  const closedTrades = safeList.filter(t => t && t.status !== 'OPEN');
  const totalTrades = closedTrades.length;
  const wins = closedTrades.filter(t => t && t.status === 'WIN').length;
  const losses = closedTrades.filter(t => t && t.status === 'LOSS').length;
  const netProfit = closedTrades.reduce((acc, t) => acc + (t?.pnl || 0), 0);
  const winRate = totalTrades > 0 ? Number(((wins / totalTrades) * 100).toFixed(1)) : 0;
  const deposits = prev.totalInjections > 0 ? prev.totalInjections : 10;
  const netProfitPct = Number(((netProfit / deposits) * 100).toFixed(1));

  return {
    ...prev,
    netProfit: Number(netProfit.toFixed(2)),
    netProfitPct,
    winRate,
    totalTrades,
    winningTrades: wins,
    losingTrades: losses,
  };
}

export default function App() {
  const [currentTab, setCurrentTab] = useState<TabId>('dashboard');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isBridgeOpen, setIsBridgeOpen] = useState(false);

  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    return safeStorage.getItem<ThemeMode>('portal_theme_mode', 'dark');
  });

  useEffect(() => {
    if (themeMode === 'dark') {
      document.documentElement.classList.add('dark');
      document.body.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
      document.body.classList.remove('dark');
    }
  }, [themeMode]);

  const handleToggleTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    safeStorage.setItem('portal_theme_mode', mode);
  };

  const [brokerConfig, setBrokerConfig] = useState<BrokerConfig>(() => {
    return safeStorage.getItem('portal_broker_config', {
      ...INITIAL_BROKER_CONFIG,
      provider: 'Fusion Markets cTrader',
      connected: true,
      currency: 'USD',
    });
  });

  const [sheetsConfig, setSheetsConfig] = useState<GoogleSheetsConfig>(() => {
    return safeStorage.getItem('portal_sheets_config', INITIAL_GOOGLE_SHEETS_CONFIG);
  });

  const [botSettings, setBotSettings] = useState<BotSettings>(() => {
    return safeStorage.getItem('portal_bot_settings', {
      ...INITIAL_BOT_SETTINGS,
      riskPerTradePct: 25.0,
      riskToReward: 2.0,
      maxDailyTrades: 4,
      weeklyDepositBaseline: 10,
      weeklyGoalTarget: 20,
      dailyGoalTarget: 5,
    });
  });

  const [limits, setLimits] = useState<AdvancedLimits>(() => {
    return safeStorage.getItem('portal_limits', {
      ...INITIAL_ADVANCED_LIMITS,
      maxDailyLossUsd: 10,
      maxWeeklyLossUsd: 25,
      maxMonthlyLossUsd: 50,
      maxDailyDrawdownPct: 20.0,
      autoLiquidateAllOnTrip: false,
    });
  });

  const [trades, setTrades] = useState<TradeRecord[]>([]);

  // Starting verified metrics from your cTrader execution
  const [metrics, setMetrics] = useState<TopMetrics>({
    netProfit: 4.62,
    netProfitPct: 46.2,
    winRate: 75.0,
    totalTrades: 4,
    winningTrades: 3,
    losingTrades: 1,
    totalInjections: 10.0,
    currentEquity: 14.62,
    currentBalance: 14.62,
    unrealizedPnL: 0.0,
  });

  const fetchJournalTrades = useCallback(async () => {
    try {
      const res = await fetch('/api/journal');
      if (res.ok) {
        const liveTrades = await res.json();
        if (Array.isArray(liveTrades) && liveTrades.length > 0) {
          setTrades(liveTrades);
          setMetrics(prev => recalculateLedgerMetrics(liveTrades, prev));
        }
      }
    } catch (err) {
      console.warn('Could not fetch journal:', err);
    }
  }, []);

  const syncBrokerTelemetry = useCallback(async () => {
    try {
      const res = await fetch('/api/broker/telemetry');
      if (!res.ok) return;
      const json = await res.json();
      if (json.status === 'success' && json.data) {
        const d = json.data;
        setBrokerConfig(prev => ({
          ...prev,
          connected: true,
          currency: d.currency ?? prev.currency ?? 'USD',
          accountNumber: d.accountNumber || prev.accountNumber,
        }));

        setMetrics(prev => {
          const liveBal = typeof d.balance === 'number' && d.balance > 0 ? d.balance : prev.currentBalance;
          const liveEq = typeof d.equity === 'number' && d.equity > 0 ? d.equity : prev.currentEquity;
          return {
            ...prev,
            currentBalance: liveBal,
            currentEquity: liveEq,
            netProfit: typeof d.netProfit === 'number' ? d.netProfit : prev.netProfit,
            winRate: typeof d.winRate === 'number' ? d.winRate : prev.winRate,
            totalTrades: typeof d.totalTrades === 'number' ? d.totalTrades : prev.totalTrades,
            winningTrades: typeof d.winningTrades === 'number' ? d.winningTrades : prev.winningTrades,
            losingTrades: typeof d.losingTrades === 'number' ? d.losingTrades : prev.losingTrades,
            unrealizedPnL: Number((liveEq - liveBal).toFixed(2)),
          };
        });
      }
      await fetchJournalTrades();
    } catch {}
  }, [fetchJournalTrades]);

  useEffect(() => {
    syncBrokerTelemetry();
    fetchJournalTrades();
    const interval = setInterval(syncBrokerTelemetry, 5000);
    return () => clearInterval(interval);
  }, [syncBrokerTelemetry, fetchJournalTrades]);

  const handleSaveBotSettings = async (newSettings: BotSettings) => {
    setBotSettings(newSettings);
    safeStorage.setItem('portal_bot_settings', newSettings);
    try {
      await fetch('/api/bot/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings),
      });
    } catch {}
  };

  const handleUpdateLimits = async (newLimits: AdvancedLimits) => {
    setLimits(newLimits);
    safeStorage.setItem('portal_limits', newLimits);
    try {
      await fetch('/api/limits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newLimits),
      });
    } catch {}
  };

  const handleDeleteTrade = async (tradeId: string) => {
    const updated = trades.filter(t => t && t.id !== tradeId && t.ticket !== tradeId);
    setTrades(updated);
    setMetrics(prev => recalculateLedgerMetrics(updated, prev));
    try {
      await fetch(`/api/journal/${tradeId}`, { method: 'DELETE' });
    } catch {}
  };

  const handleResetJournal = async () => {
    setTrades([]);
    setMetrics(prev => recalculateLedgerMetrics([], prev));
    try {
      await fetch('/api/journal/reset', { method: 'POST' });
    } catch {}
  };

  const handleAddTrade = async (newTrade: TradeRecord) => {
    const updated = [newTrade, ...trades];
    setTrades(updated);
    setMetrics(prev => recalculateLedgerMetrics(updated, prev));
    try {
      await fetch('/api/journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTrade),
      });
    } catch {}
  };

  const [branding, setBranding] = useState<SiteBrandingConfig>(() => {
    return safeStorage.getItem('portal_branding_config', INITIAL_BRANDING_CONFIG);
  });

  return (
    <div className={`flex flex-col h-screen w-screen overflow-hidden font-sans selection:bg-blue-600 selection:text-white ${
      themeMode === 'dark' ? 'dark bg-[#07090e] text-slate-100' : 'bg-white text-black'
    }`}>
      <HeaderClocks 
        botActive={botSettings.masterExecution && !limits.breakerTriggered}
        onToggleBotActive={() => handleSaveBotSettings({ ...botSettings, masterExecution: !botSettings.masterExecution })}
        themeMode={themeMode}
        onToggleTheme={handleToggleTheme}
        currentEquity={metrics.currentEquity}
        brokerConfig={brokerConfig}
        branding={branding}
        onOpenBridge={() => setIsBridgeOpen(true)}
        onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          currentTab={currentTab}
          onSelectTab={setCurrentTab}
          botActive={botSettings.masterExecution && !limits.breakerTriggered}
          themeMode={themeMode}
          isOpen={isSidebarOpen}
          onClose={() => setIsSidebarOpen(false)}
        />

        <main className={`flex-1 h-full overflow-hidden relative ${themeMode === 'dark' ? 'bg-[#07090e]' : 'bg-white'}`}>
          {currentTab === 'dashboard' && (
            <DashboardView
              metrics={metrics}
              botSettings={botSettings}
              trades={trades}
              onSaveBotSettings={handleSaveBotSettings}
              onQuickNavigate={setCurrentTab}
              themeMode={themeMode}
              brokerCurrency={brokerConfig.currency || 'USD'}
              onOpenBridge={() => setIsBridgeOpen(true)}
            />
          )}

          {currentTab === 'journal' && (
            <TradeJournalView
              trades={trades}
              onAddTrade={handleAddTrade}
              onDeleteTrade={handleDeleteTrade}
              onResetJournal={handleResetJournal}
              sheetsConfig={sheetsConfig}
              brokerConfig={brokerConfig}
              themeMode={themeMode}
            />
          )}

          {currentTab === 'limits' && (
            <AdvancedLimitsView
              limits={limits}
              onUpdateLimits={handleUpdateLimits}
              currentEquity={metrics.currentEquity}
              themeMode={themeMode}
              onHaltBot={(halted) => handleSaveBotSettings({ ...botSettings, masterExecution: !halted })}
            />
          )}

          {currentTab === 'calendar' && (
            <EconomicCalendarView themeMode={themeMode} />
          )}

          {currentTab === 'live_feed' && (
            <LiveFeedView
              currentEquity={metrics.currentEquity}
              riskPerTradePct={botSettings.riskPerTradePct}
              themeMode={themeMode}
              activeTrades={trades}
            />
          )}

          {currentTab === 'backtest' && (
            <BacktestView
              themeMode={themeMode}
              brokerCurrency={brokerConfig.currency || 'USD'}
            />
          )}

          {currentTab === 'settings' && (
            <SettingsView
              themeMode={themeMode}
              onToggleTheme={handleToggleTheme}
              brokerConfig={brokerConfig}
              onUpdateBrokerConfig={(c) => setBrokerConfig(c)}
              sheetsConfig={sheetsConfig}
              onUpdateSheetsConfig={(s) => setSheetsConfig(s)}
              botSettings={botSettings}
              metrics={metrics}
              onUpdateMetrics={(m) => setMetrics(m)}
              branding={branding}
              onUpdateBranding={(b) => setBranding(b)}
              botActive={botSettings.masterExecution && !limits.breakerTriggered}
              onToggleBotActive={() => handleSaveBotSettings({ ...botSettings, masterExecution: !botSettings.masterExecution })}
            />
          )}
        </main>
      </div>

      

      <BrokerVsCodeBridgeModal
        isOpen={isBridgeOpen}
        onClose={() => setIsBridgeOpen(false)}
        botSettings={botSettings}
        brokerConfig={brokerConfig}
        metrics={metrics}
        themeMode={themeMode}
        onSyncTelemetry={syncBrokerTelemetry}
      />
    </div>
  );
}
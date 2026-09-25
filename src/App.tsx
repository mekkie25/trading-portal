import React, { useState, useEffect, useCallback } from 'react';
import { HeaderClocks } from './components/HeaderClocks';
import { Sidebar } from './components/Sidebar';
import { DashboardView } from './components/views/DashboardView';
import { TradeJournalView } from './components/views/TradeJournalView';
import { AdvancedLimitsView } from './components/views/AdvancedLimitsView';
import { EconomicCalendarView } from './components/views/EconomicCalendarView';
import { LiveFeedView } from './components/views/LiveFeedView';
import { SettingsView } from './components/views/SettingsView';
import { BrokerVsCodeBridgeModal } from './components/BrokerVsCodeBridgeModal';

import { 
  INITIAL_METRICS, 
  INITIAL_BOT_SETTINGS, 
  INITIAL_ADVANCED_LIMITS, 
  INITIAL_TRADES,
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
  const totalTrades = safeList.length;
  const wins = safeList.filter(t => t && t.status === 'WIN').length;
  const losses = safeList.filter(t => t && t.status === 'LOSS').length;
  const netProfit = safeList.reduce((acc, t) => acc + (t?.pnl || 0), 0);
  const winRate = totalTrades > 0 ? Number(((wins / totalTrades) * 100).toFixed(1)) : 0;
  const deposits = prev.totalInjections > 0 ? prev.totalInjections : 10000;
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
    return safeStorage.getItem('portal_broker_config', INITIAL_BROKER_CONFIG);
  });

  const [sheetsConfig, setSheetsConfig] = useState<GoogleSheetsConfig>(() => {
    return safeStorage.getItem('portal_sheets_config', INITIAL_GOOGLE_SHEETS_CONFIG);
  });

  const [botSettings, setBotSettings] = useState<BotSettings>(() => {
    return safeStorage.getItem('2gs_bot_settings', INITIAL_BOT_SETTINGS);
  });

  const [limits, setLimits] = useState<AdvancedLimits>(() => {
    return safeStorage.getItem('2gs_limits', INITIAL_ADVANCED_LIMITS);
  });

  const [trades, setTrades] = useState<TradeRecord[]>(() => {
    return safeStorage.getItem('2gs_trades', INITIAL_TRADES);
  });

  const [metrics, setMetrics] = useState<TopMetrics>(() => {
    const cached = safeStorage.getItem('2gs_metrics', INITIAL_METRICS);
    return recalculateLedgerMetrics(INITIAL_TRADES, cached);
  });

  const handleSaveBotSettings = async (newSettings: BotSettings) => {
    setBotSettings(newSettings);
    safeStorage.setItem('2gs_bot_settings', newSettings);

    try {
      await fetch('/api/bot/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings),
      });
    } catch {}
  };

  // STABLE TELEMETRY SYNC (Zero Infinite Loops)
  const syncBrokerTelemetry = useCallback(async () => {
    try {
      const res = await fetch('/api/broker/telemetry');
      if (!res.ok) return;
      const json = await res.json();
      if (json.status === 'success' && json.data) {
        const d = json.data;
        setBrokerConfig(prev => ({
          ...prev,
          connected: d.connected ?? prev.connected,
          currency: d.currency ?? prev.currency ?? 'USD',
          accountNumber: d.accountNumber || prev.accountNumber,
        }));

        setMetrics(prev => {
          const liveBal = typeof d.balance === 'number' && d.balance > 0 ? d.balance : prev.currentBalance;
          const liveEq = typeof d.equity === 'number' && d.equity > 0 ? d.equity : prev.currentEquity;
          const deposits = typeof d.totalDeposits === 'number' ? d.totalDeposits : prev.totalInjections;
          return {
            ...prev,
            currentBalance: liveBal,
            currentEquity: liveEq,
            totalInjections: deposits,
            unrealizedPnL: Number((liveEq - liveBal).toFixed(2)),
          };
        });
      }
    } catch {}
  }, []);

  useEffect(() => {
    syncBrokerTelemetry();
    const interval = setInterval(syncBrokerTelemetry, 8000);
    return () => clearInterval(interval);
  }, [syncBrokerTelemetry]);

  // DELETE SINGLE TRADE: Recalculates metrics immediately without reloading
  const handleDeleteTrade = async (tradeId: string) => {
    const updated = trades.filter(t => t && t.id !== tradeId);
    setTrades(updated);
    safeStorage.setItem('2gs_trades', updated);
    setMetrics(prev => recalculateLedgerMetrics(updated, prev));

    try {
      await fetch(`/api/journal/${tradeId}`, { method: 'DELETE' });
    } catch {}
  };

  // WIPE ENTIRE JOURNAL: Resets ledger to 0
  const handleResetJournal = async () => {
    setTrades([]);
    safeStorage.setItem('2gs_trades', []);
    setMetrics(prev => recalculateLedgerMetrics([], prev));

    try {
      await fetch('/api/journal/reset', { method: 'POST' });
    } catch {}
  };

  const handleAddTrade = (newTrade: TradeRecord) => {
    const updated = [newTrade, ...trades];
    setTrades(updated);
    safeStorage.setItem('2gs_trades', updated);
    setMetrics(prev => recalculateLedgerMetrics(updated, prev));
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
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          currentTab={currentTab}
          onSelectTab={setCurrentTab}
          botActive={botSettings.masterExecution && !limits.breakerTriggered}
          themeMode={themeMode}
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
              onUpdateLimits={(l) => setLimits(l)}
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
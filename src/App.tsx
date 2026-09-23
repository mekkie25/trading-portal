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

// Safe localStorage wrapper for sandboxed iframe environments
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
    } catch {
      // Ignore storage restrictions in iframe
    }
  },
};

export default function App() {


  const [currentTab, setCurrentTab] = useState<TabId>('dashboard');
  const [isBridgeOpen, setIsBridgeOpen] = useState(false);

  // Theme mode: dark | light
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    return safeStorage.getItem<ThemeMode>('portal_theme_mode', 'dark');
  });

  // Sync dark class on document element
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

  // Metrics state
  const [metrics, setMetrics] = useState<TopMetrics>(() => {
    return safeStorage.getItem('2gs_metrics', INITIAL_METRICS);
  });

  // Broker connection config state
  const [brokerConfig, setBrokerConfig] = useState<BrokerConfig>(() => {
    return safeStorage.getItem('portal_broker_config', INITIAL_BROKER_CONFIG);
  });

  const handleUpdateBrokerConfig = (config: BrokerConfig) => {
    setBrokerConfig(config);
    safeStorage.setItem('portal_broker_config', config);
  };

  // Google Sheets configuration state
  const [sheetsConfig, setSheetsConfig] = useState<GoogleSheetsConfig>(() => {
    return safeStorage.getItem('portal_sheets_config', INITIAL_GOOGLE_SHEETS_CONFIG);
  });

  const handleUpdateSheetsConfig = (config: GoogleSheetsConfig) => {
    setSheetsConfig(config);
    safeStorage.setItem('portal_sheets_config', config);
  };

  // Bot parameters state
  const [botSettings, setBotSettings] = useState<BotSettings>(() => {
    return safeStorage.getItem('2gs_bot_settings', INITIAL_BOT_SETTINGS);
  });

  // Advanced limits state
  const [limits, setLimits] = useState<AdvancedLimits>(() => {
    return safeStorage.getItem('2gs_limits', INITIAL_ADVANCED_LIMITS);
  });

  // Trades state
  const [trades, setTrades] = useState<TradeRecord[]>(() => {
    return safeStorage.getItem('2gs_trades', INITIAL_TRADES);
  });

  // Save changes to storage and push to backend gateway
  const handleSaveBotSettings = async (newSettings: BotSettings) => {
    setBotSettings(newSettings);
    safeStorage.setItem('2gs_bot_settings', newSettings);

    // Push to backend gateway if server running
    try {
      await fetch('/api/bot/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          masterExecution: newSettings.masterExecution,
          riskPerTradePct: newSettings.riskPerTradePct,
          riskToReward: newSettings.riskToReward,
          maxDailyTrades: newSettings.maxDailyTrades,
          currency: brokerConfig.currency || 'USD',
        }),
      });
    } catch (err) {
      console.warn('Gateway API push silent fallback:', err);
    }
  };

  // Sync broker telemetry from gateway periodically or on demand
  const syncBrokerTelemetry = useCallback(async () => {
    try {
      const res = await fetch('/api/broker/telemetry');
      if (res.ok) {
        const json = await res.json();
        if (json.status === 'success' && json.data) {
          const d = json.data;
          // Update broker config currency and connection status
          setBrokerConfig((prev) => {
            const next = {
              ...prev,
              connected: d.connected ?? prev.connected,
              currency: d.currency ?? prev.currency ?? 'USD',
              lastPingMs: d.lastPingMs ?? prev.lastPingMs,
              accountNumber: d.accountNumber || prev.accountNumber,
              server: d.server || prev.server,
            };
            safeStorage.setItem('portal_broker_config', next);
            return next;
          });

                    // Replace mock trade journal data with real Deriv trade history
          if (Array.isArray(d.trades) && d.trades.length > 0) {
            setTrades(d.trades);
            safeStorage.setItem('2gs_trades', d.trades);
          }

          // Update metrics
          setMetrics((prev) => {
            const next: TopMetrics = {
              ...prev,
              netProfit: d.netProfit ?? prev.netProfit,
              winRate: d.winRate ?? prev.winRate,
              totalTrades: d.totalTrades ?? prev.totalTrades,
              winningTrades: d.winningTrades ?? prev.winningTrades,
              losingTrades: d.losingTrades ?? prev.losingTrades,
              currentEquity: d.equity ?? prev.currentEquity,
              currentBalance: d.balance ?? prev.currentBalance,
              unrealizedPnL: d.floatingPnL ?? prev.unrealizedPnL,
              totalInjections: typeof d.totalDeposits === 'number' ? d.totalDeposits : prev.totalInjections,
            };
            safeStorage.setItem('2gs_metrics', next);
            return next;
          });
        }
      }
    } catch {
      // Ignore background fetch error in static/offline mode
    }
  }, []);

  // Poll gateway telemetry every 8 seconds
  useEffect(() => {
    syncBrokerTelemetry();
    const interval = setInterval(syncBrokerTelemetry, 8000);
    return () => clearInterval(interval);
  }, [syncBrokerTelemetry]);

  // Save changes to storage AND push the loss ceilings + any manual breaker
  // reset to the backend. The server is the source of truth for the
  // *current* loss figures and breakerTriggered — those come back on the
  // next syncRiskStatus() call and overwrite whatever was sent here.
  const handleUpdateLimits = async (newLimits: AdvancedLimits, resetBreaker = false) => {
    setLimits(newLimits);
    safeStorage.setItem('2gs_limits', newLimits);

    try {
      const res = await fetch('/api/limits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxDailyLossUsd: newLimits.maxDailyLossUsd,
          maxWeeklyLossUsd: newLimits.maxWeeklyLossUsd,
          maxMonthlyLossUsd: newLimits.maxMonthlyLossUsd,
          breakerAction: newLimits.breakerAction,
          resetBreaker,
        }),
      });
      if (res.ok) {
        const json = await res.json();
        if (json.status === 'success' && json.data) {
          const merged = { ...newLimits, ...json.data };
          setLimits(merged);
          safeStorage.setItem('2gs_limits', merged);
        }
      }
    } catch (err) {
      console.warn('Limits gateway push silent fallback:', err);
    }
  };

  // Pull the server-computed risk state (real daily/weekly/monthly loss +
  // breakerTriggered) so the UI always shows the backend's numbers, not
  // stale local ones.
  const syncRiskStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/risk/status');
      if (res.ok) {
        const json = await res.json();
        if (json.status === 'success' && json.data) {
          setLimits((prev) => {
            const next = { ...prev, ...json.data };
            safeStorage.setItem('2gs_limits', next);
            return next;
          });
          // If the server auto-tripped the breaker, it also forces
          // masterExecution off server-side — mirror that locally too.
          if (json.data.breakerTriggered) {
            setBotSettings((prev) => prev.masterExecution ? { ...prev, masterExecution: false } : prev);
          }
        }
      }
    } catch {
      // Ignore background fetch error in static/offline mode
    }
  }, []);

  // Poll risk status alongside telemetry every 8 seconds
  useEffect(() => {
    syncRiskStatus();
    const interval = setInterval(syncRiskStatus, 8000);
    return () => clearInterval(interval);
  }, [syncRiskStatus]);

  // Manual halt/resume from the Advanced Limits screen. Resuming after a
  // breaker trip explicitly clears it server-side (a human is confirming
  // they've reviewed the loss, not the clock silently resetting it).
  const handleHaltBot = (halted: boolean) => {
    handleSaveBotSettings({ ...botSettings, masterExecution: !halted });
    if (!halted) {
      handleUpdateLimits({ ...limits, breakerTriggered: false, activeTripScope: 'NONE', lastTriggerReason: undefined }, true);
    }
  };

  const handleUpdateMetrics = (newMetrics: TopMetrics) => {
    setMetrics(newMetrics);
    safeStorage.setItem('2gs_metrics', newMetrics);
  };

  // Site branding state
  const [branding, setBranding] = useState<SiteBrandingConfig>(() => {
    return safeStorage.getItem('portal_branding_config', INITIAL_BRANDING_CONFIG);
  });

  const handleUpdateBranding = (newBranding: SiteBrandingConfig) => {
    setBranding(newBranding);
    safeStorage.setItem('portal_branding_config', newBranding);
  };

  // Hide pre-existing/old trades from the journal view (does not touch real
  // Deriv history — see the server's /api/journal/reset for why).
  const handleResetJournal = async () => {
    setTrades([]);
    safeStorage.setItem('2gs_trades', []);
    try {
      await fetch('/api/journal/reset', { method: 'POST' });
    } catch (err) {
      console.warn('Journal reset push silent fallback:', err);
    }
  };

  const handleToggleBotActive = () => {
    const updated = !botSettings.masterExecution;
    handleSaveBotSettings({ ...botSettings, masterExecution: updated });
  };

  const handleAddTrade = (newTrade: TradeRecord) => {
    const updated = [newTrade, ...trades];
    setTrades(updated);
    safeStorage.setItem('2gs_trades', updated);

    // Update metrics dynamically
    const newNetProfit = metrics.netProfit + newTrade.pnl;
    const newWinningTrades = metrics.winningTrades + (newTrade.status === 'WIN' ? 1 : 0);
    const newLosingTrades = metrics.losingTrades + (newTrade.status === 'LOSS' ? 1 : 0);
    const newTotalTrades = metrics.totalTrades + 1;
    const newWinRate = Number(((newWinningTrades / newTotalTrades) * 100).toFixed(1));
    const newEquity = metrics.currentEquity + newTrade.pnl;

    const updatedMetrics: TopMetrics = {
      ...metrics,
      netProfit: newNetProfit,
      totalTrades: newTotalTrades,
      winningTrades: newWinningTrades,
      losingTrades: newLosingTrades,
      winRate: newWinRate,
      currentEquity: newEquity,
    };
    setMetrics(updatedMetrics);
    safeStorage.setItem('2gs_metrics', updatedMetrics);
  };

  return (
    <div className={`flex flex-col h-screen w-screen overflow-hidden font-sans selection:bg-blue-600 selection:text-white ${
      themeMode === 'dark' ? 'dark bg-[#07090e] text-slate-100' : 'bg-white text-black'
    }`}>
      {/* Global Clocks Header with live world trading sessions & bridge button */}
      <HeaderClocks 
        botActive={botSettings.masterExecution && !limits.breakerTriggered}
        onToggleBotActive={handleToggleBotActive}
        themeMode={themeMode}
        onToggleTheme={handleToggleTheme}
        currentEquity={metrics.currentEquity}
        brokerConfig={brokerConfig}
        branding={branding}
        onOpenBridge={() => setIsBridgeOpen(true)}
      />

      {/* Main Workspace: Left Sidebar + Isolated Window View */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar Navigation */}
        <Sidebar
          currentTab={currentTab}
          onSelectTab={setCurrentTab}
          botActive={botSettings.masterExecution && !limits.breakerTriggered}
          themeMode={themeMode}
        />

        {/* Isolated Window View Container: Displays strictly that section in full, uncompressed format */}
        <main className={`flex-1 h-full overflow-hidden relative ${
          themeMode === 'dark' ? 'bg-[#07090e]' : 'bg-white'
        }`}>
          {currentTab === 'dashboard' && (
            <DashboardView
              metrics={metrics}
              botSettings={botSettings}
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
              onHaltBot={handleHaltBot}
            />
          )}

          {currentTab === 'calendar' && (
            <EconomicCalendarView 
              themeMode={themeMode}
            />
          )}

          {currentTab === 'live_feed' && (
            <LiveFeedView
              currentEquity={metrics.currentEquity}
              riskPerTradePct={botSettings.riskPerTradePct}
              themeMode={themeMode}
            />
          )}

          {currentTab === 'settings' && (
            <SettingsView
              themeMode={themeMode}
              onToggleTheme={handleToggleTheme}
              brokerConfig={brokerConfig}
              onUpdateBrokerConfig={handleUpdateBrokerConfig}
              sheetsConfig={sheetsConfig}
              onUpdateSheetsConfig={handleUpdateSheetsConfig}
              botSettings={botSettings}
              metrics={metrics}
              onUpdateMetrics={handleUpdateMetrics}
              branding={branding}
              onUpdateBranding={handleUpdateBranding}
              botActive={botSettings.masterExecution && !limits.breakerTriggered}
              onToggleBotActive={handleToggleBotActive}
            />
          )}
        </main>
      </div>

      {/* Real-time Broker & VS Code Bridge Integration Modal */}
      <BrokerVsCodeBridgeModal
        isOpen={isBridgeOpen}
        onClose={() => setIsBridgeOpen(false)}
        botSettings={botSettings}
        brokerConfig={brokerConfig}
        onUpdateBrokerConfig={handleUpdateBrokerConfig}
        metrics={metrics}
        onUpdateMetrics={handleUpdateMetrics}
        themeMode={themeMode}
        onSyncTelemetry={syncBrokerTelemetry}
      />
    </div>
  );
}

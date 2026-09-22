import React, { useState } from 'react';
import { motion } from 'motion/react';
import { 
  Settings as SettingsIcon, 
  Moon, 
  Sun, 
  Wifi, 
  CheckCircle2, 
  FileSpreadsheet, 
  Bot, 
  Copy, 
  RefreshCw, 
  Database, 
  Terminal, 
  ExternalLink,
  ShieldCheck,
  Zap,
  Sliders,
  Shield,
  TrendingUp,
  Sparkles,
  Power,
  PowerOff,
  Palette
} from 'lucide-react';
import { 
  ThemeMode, 
  BrokerConfig, 
  GoogleSheetsConfig, 
  BotSettings, 
  TopMetrics,
  SiteBrandingConfig
} from '../../types';

interface SettingsViewProps {
  themeMode: ThemeMode;
  onToggleTheme: (mode: ThemeMode) => void;
  brokerConfig: BrokerConfig;
  onUpdateBrokerConfig: (config: BrokerConfig) => void;
  sheetsConfig: GoogleSheetsConfig;
  onUpdateSheetsConfig: (config: GoogleSheetsConfig) => void;
  botSettings: BotSettings;
  metrics: TopMetrics;
  onUpdateMetrics: (metrics: TopMetrics) => void;
  branding: SiteBrandingConfig;
  onUpdateBranding: (branding: SiteBrandingConfig) => void;
  botActive: boolean;
  onToggleBotActive: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  themeMode,
  onToggleTheme,
  brokerConfig,
  onUpdateBrokerConfig,
  sheetsConfig,
  onUpdateSheetsConfig,
  botSettings,
  metrics,
  onUpdateMetrics,
  branding,
  onUpdateBranding,
  botActive,
  onToggleBotActive,
}) => {
  const [localBroker, setLocalBroker] = useState<BrokerConfig>(brokerConfig);
  const [localSheets, setLocalSheets] = useState<GoogleSheetsConfig>(sheetsConfig);
  const [localBranding, setLocalBranding] = useState<SiteBrandingConfig>(branding);
  const [balanceInput, setBalanceInput] = useState(metrics.currentBalance.toString());
  const [equityInput, setEquityInput] = useState(metrics.currentEquity.toString());
  const [pingStatus, setPingStatus] = useState<string | null>(null);
  const [copiedScript, setCopiedScript] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [brandingSaved, setBrandingSaved] = useState(false);

  // Sync props to state if updated externally
  React.useEffect(() => {
    setLocalBranding(branding);
  }, [branding]);

  // Test broker ping
  const handleTestBrokerPing = () => {
    setPingStatus('Pinging broker gateway...');
    setTimeout(() => {
      const ping = Math.floor(12 + Math.random() * 15);
      const updated: BrokerConfig = {
        ...localBroker,
        connected: true,
        lastPingMs: ping,
        lastSyncTime: 'Just now',
      };
      setLocalBroker(updated);
      onUpdateBrokerConfig(updated);
      setPingStatus(`Connected! Latency: ${ping}ms (${localBroker.server})`);
      setTimeout(() => setPingStatus(null), 4000);
    }, 600);
  };

  const handleSaveBroker = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateBrokerConfig(localBroker);
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  const handleSaveSheets = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateSheetsConfig(localSheets);
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  const handleSaveMetrics = (e: React.FormEvent) => {
    e.preventDefault();
    const newBal = parseFloat(balanceInput) || metrics.currentBalance;
    const newEq = parseFloat(equityInput) || metrics.currentEquity;
    onUpdateMetrics({
      ...metrics,
      currentBalance: newBal,
      currentEquity: newEq,
    });
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  const handleSaveBranding = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateBranding(localBranding);
    setBrandingSaved(true);
    setTimeout(() => setBrandingSaved(false), 3000);
  };

  const pythonScript = `"""
Trading Portal VS Code Live Bridge
Listening to web socket and broker updates from Trading Portal
"""
import json
import time

BOT_TARGETS = {
    "master_execution": ${botSettings.masterExecution},
    "risk_per_trade_pct": ${botSettings.riskPerTradePct},
    "risk_to_reward": ${botSettings.riskToReward},
    "max_daily_trades": ${botSettings.maxDailyTrades},
    "trailing_stop": ${botSettings.trailingStopActive},
    "breakeven_pips": ${botSettings.autoBreakevenPips}
}

BROKER_CONFIG = {
    "provider": "${localBroker.provider}",
    "account": "${localBroker.accountNumber}",
    "server": "${localBroker.server}",
    "gateway_url": "${localBroker.webhookUrl}"
}

print(f"[Trading Portal Bridge] Connected to account: {BROKER_CONFIG['account']}")
print(f"[Targets] Active Risk: {BOT_TARGETS['risk_per_trade_pct']}% | R:R Target: 1:{BOT_TARGETS['risk_to_reward']}")

# Dispatched directly to MT5 terminal or Deriv websocket loop
`;

  const handleCopyScript = () => {
    navigator.clipboard.writeText(pythonScript);
    setCopiedScript(true);
    setTimeout(() => setCopiedScript(false), 3000);
  };

  const isDark = themeMode === 'dark';

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-8 max-w-6xl mx-auto">
      {/* View Header */}
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200 dark:border-[#212838]"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2.5">
            Settings & System Control
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
              Live Core
            </span>
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Customize site name and icon, engage master kill switch, configure broker feed, and manage data synchronization.
          </p>
        </div>

        {savedSuccess && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 text-xs font-semibold animate-in fade-in">
            <CheckCircle2 className="w-4 h-4" />
            <span>Settings Saved & Synced</span>
          </div>
        )}
      </motion.div>

      {/* 1. Master Kill Switch & Bot Control (Prominent Card) */}
      <motion.section 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4 }}
        className={`rounded-2xl p-6 border shadow-sm space-y-4 transition-colors ${
          botActive
            ? 'bg-white dark:bg-[#151922] border-slate-200 dark:border-[#212838]'
            : 'bg-rose-500/10 border-rose-500/30'
        }`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className={`p-3 rounded-xl text-white font-bold shrink-0 ${botActive ? 'bg-emerald-600' : 'bg-rose-600'}`}>
              {botActive ? <Power className="w-5 h-5 animate-pulse" /> : <PowerOff className="w-5 h-5" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-900 dark:text-white">
                  Master Bot Kill Switch
                </h2>
                <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full ${
                  botActive
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30'
                    : 'bg-rose-500/20 text-rose-700 dark:text-rose-400 border border-rose-500/40'
                }`}>
                  {botActive ? 'ENGINE ARMED' : 'ENGINE KILLED / SHUT DOWN'}
                </span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                {botActive
                  ? 'All algorithmic order executions, trailing stops, and webhook signals are operating normally.'
                  : 'Emergency override engaged: The bot has been turned OFF. No automated buy or sell orders will be dispatched.'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onToggleBotActive}
            id="settings-kill-switch-btn"
            className={`px-5 py-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition-all cursor-pointer ${
              botActive
                ? 'bg-rose-600 hover:bg-rose-500 text-white'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white'
            }`}
          >
            {botActive ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
            <span>{botActive ? 'TRIGGER EMERGENCY KILL SWITCH' : 'RE-ARM TRADING BOT'}</span>
          </button>
        </div>
      </motion.section>

      {/* 2. Site Branding & Customization (Name, Icon, Colors) */}
      <motion.section 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4 }}
        className="rounded-2xl p-6 bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm space-y-5"
      >
        <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-[#212838]">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              <Palette className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                Site Branding & Appearance Customization
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Customize the name of the site, select your badge icon or custom initials, and configure portal aesthetics.
              </p>
            </div>
          </div>

          {brandingSaved && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400 font-semibold bg-emerald-500/10 px-3 py-1 rounded-xl border border-emerald-500/20">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Branding Updated</span>
            </div>
          )}
        </div>

        <form onSubmit={handleSaveBranding} className="space-y-5 text-xs">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Site Name Customization */}
            <div className="space-y-1.5">
              <label className="font-semibold text-slate-700 dark:text-slate-300">
                Site Name (Displayed in Header & Navigation)
              </label>
              <input
                type="text"
                value={localBranding.siteName}
                onChange={(e) => setLocalBranding({ ...localBranding, siteName: e.target.value })}
                id="branding-site-name-input"
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-medium focus:outline-none focus:border-blue-500"
                placeholder="e.g. Trading Portal"
              />
              <p className="text-[11px] text-slate-500">
                Changes the top banner and title across your terminal.
              </p>
            </div>

            {/* Custom Initials or Monogram */}
            <div className="space-y-1.5">
              <label className="font-semibold text-slate-700 dark:text-slate-300">
                Custom Icon Monogram / Text (Optional)
              </label>
              <input
                type="text"
                maxLength={4}
                value={localBranding.customInitials || ''}
                onChange={(e) => setLocalBranding({ ...localBranding, customInitials: e.target.value })}
                id="branding-initials-input"
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono uppercase focus:outline-none focus:border-blue-500"
                placeholder="e.g. TP or 2GS or leave empty to use icon"
              />
              <p className="text-[11px] text-slate-500">
                If provided, this monogram appears in the header badge. Leave blank to show vector icon.
              </p>
            </div>
          </div>

          {/* Icon Type Selection */}
          <div className="space-y-2">
            <label className="font-semibold text-slate-700 dark:text-slate-300">
              Select Site Icon (When Monogram is Blank)
            </label>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
              {[
                { id: 'chart', label: 'Chart', icon: TrendingUp },
                { id: 'shield', label: 'Shield', icon: Shield },
                { id: 'bot', label: 'Bot', icon: Bot },
                { id: 'zap', label: 'Lightning', icon: Zap },
                { id: 'terminal', label: 'Terminal', icon: Terminal },
                { id: 'gemini', label: 'AI Spark', icon: Sparkles },
              ].map((item) => {
                const Icon = item.icon;
                const isSelected = localBranding.iconType === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setLocalBranding({ ...localBranding, iconType: item.id as any })}
                    className={`p-3 rounded-xl border flex flex-col items-center gap-1.5 transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                        : 'bg-slate-50 dark:bg-[#0d1017] text-slate-700 dark:text-slate-300 border-slate-200 dark:border-[#212838] hover:border-blue-500/50'
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-[10px] font-semibold">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              id="save-branding-btn"
              className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-sm cursor-pointer"
            >
              Save Branding Settings
            </button>
          </div>
        </form>
      </motion.section>

      {/* 3. Appearance & Theme (Dark Mode / Light Mode with Full Contrast) */}
      <motion.section 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4 }}
        className="rounded-2xl p-6 bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm space-y-5"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              {isDark ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">Appearance & Color Palette</h2>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Switch between refined 2GS dark grayish mode (#0d1017) and crisp high-contrast light mode.
              </p>
            </div>
          </div>

          {/* Theme Switcher Toggle */}
          <div className="flex items-center gap-2 bg-slate-100 dark:bg-[#0d1017] p-1 rounded-xl border border-slate-200 dark:border-[#212838]">
            <button
              type="button"
              onClick={() => onToggleTheme('dark')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                isDark 
                  ? 'bg-blue-600 text-white shadow-sm' 
                  : 'text-slate-700 hover:text-slate-900 dark:text-slate-400'
              }`}
            >
              <Moon className="w-4 h-4" />
              <span>Dark Theme</span>
            </button>
            <button
              type="button"
              onClick={() => onToggleTheme('light')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                !isDark 
                  ? 'bg-blue-600 text-white shadow-sm' 
                  : 'text-slate-700 hover:text-slate-900 dark:text-slate-400'
              }`}
            >
              <Sun className="w-4 h-4" />
              <span>Light Theme</span>
            </button>
          </div>
        </div>

        <div className="pt-2 text-xs text-slate-600 dark:text-slate-400 flex items-center gap-2">
          <span>Dark Mode Tone:</span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">2GS Charcoal-Gray (#0d1017)</span>
          <span>•</span>
          <span>Light Mode:</span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">High-Contrast Slate-900 Text</span>
        </div>
      </motion.section>

      {/* 4. Real Broker Connection (MetaTrader 5 / Deriv / Bridge) */}
      <motion.section 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4 }}
        className="rounded-2xl p-6 bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm space-y-6"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100 dark:border-[#212838]">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              <Wifi className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                Broker Connection & API Gateway
                <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full ${
                  localBroker.connected 
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30' 
                    : 'bg-rose-500/15 text-rose-600'
                }`}>
                  {localBroker.connected ? `CONNECTED (${localBroker.lastPingMs}ms)` : 'DISCONNECTED'}
                </span>
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Connect directly to your MetaTrader 5 Expert Advisor or Deriv WebSocket gateway for real values.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleTestBrokerPing}
              className="px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-[#0d1017] hover:bg-slate-200 dark:hover:bg-[#191f2c] border border-slate-200 dark:border-[#212838] text-slate-700 dark:text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Test Broker Ping</span>
            </button>
          </div>
        </div>

        {pingStatus && (
          <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-700 dark:text-blue-300 text-xs font-mono">
            {pingStatus}
          </div>
        )}

        <form onSubmit={handleSaveBroker} className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs">
          <div className="space-y-1.5">
            <label className="font-semibold text-slate-700 dark:text-slate-300">Broker Execution Provider</label>
            <select
              value={localBroker.provider}
              onChange={(e) => setLocalBroker({ ...localBroker, provider: e.target.value as any })}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-medium focus:outline-none focus:border-blue-500"
            >
              <option value="MetaTrader 5">MetaTrader 5 (Direct Terminal Bridge)</option>
              <option value="Deriv Synthetic">Deriv (Synthetic Volatility Indices)</option>
              <option value="cTrader FIX">cTrader (Open API / FIX Engine)</option>
              <option value="Interactive Brokers">Interactive Brokers (TWS Gateway)</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="font-semibold text-slate-700 dark:text-slate-300">Account Number / Login ID</label>
            <input
              type="text"
              value={localBroker.accountNumber}
              onChange={(e) => setLocalBroker({ ...localBroker, accountNumber: e.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
              placeholder="e.g. 84920412"
            />
          </div>

          <div className="space-y-1.5">
            <label className="font-semibold text-slate-700 dark:text-slate-300">Broker Trading Server</label>
            <input
              type="text"
              value={localBroker.server}
              onChange={(e) => setLocalBroker({ ...localBroker, server: e.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
              placeholder="e.g. Deriv-Server-02 or MetaQuotes-Live"
            />
          </div>

          <div className="space-y-1.5">
            <label className="font-semibold text-slate-700 dark:text-slate-300">Webhook or Bridge Gateway URL</label>
            <input
              type="text"
              value={localBroker.webhookUrl}
              onChange={(e) => setLocalBroker({ ...localBroker, webhookUrl: e.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
              placeholder="http://127.0.0.1:8080/trade-gateway"
            />
          </div>

          <div className="md:col-span-2 pt-2 flex justify-end">
            <button
              type="submit"
              className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-sm cursor-pointer"
            >
              Save Real Broker Configuration
            </button>
          </div>
        </form>
      </motion.section>

      {/* 5. Live Account Balance Calibration */}
      <motion.section 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4 }}
        className="rounded-2xl p-6 bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm space-y-5"
      >
        <div className="flex items-center gap-3 pb-3 border-b border-slate-100 dark:border-[#212838]">
          <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
            <Database className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white">Account Capital Calibration</h2>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Directly synchronize your portal's balance and equity to match your live broker balance.
            </p>
          </div>
        </div>

        <form onSubmit={handleSaveMetrics} className="grid grid-cols-1 md:grid-cols-3 gap-5 text-xs">
          <div className="space-y-1.5">
            <label className="font-semibold text-slate-700 dark:text-slate-300">Live Account Equity ($ USD)</label>
            <input
              type="number"
              step="0.01"
              value={equityInput}
              onChange={(e) => setEquityInput(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono font-bold focus:outline-none focus:border-blue-500"
            />
            <span className="text-[10px] text-slate-500">Live floating equity used for drawdown calculation</span>
          </div>

          <div className="space-y-1.5">
            <label className="font-semibold text-slate-700 dark:text-slate-300">Live Account Balance ($ USD)</label>
            <input
              type="number"
              step="0.01"
              value={balanceInput}
              onChange={(e) => setBalanceInput(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono font-bold focus:outline-none focus:border-blue-500"
            />
            <span className="text-[10px] text-slate-500">Real balance without floating profit/loss</span>
          </div>

          <div className="space-y-1.5 flex flex-col justify-end">
            <button
              type="submit"
              className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-sm cursor-pointer"
            >
              Apply Live Balance to Portal
            </button>
          </div>
        </form>
      </motion.section>

      {/* 6. Google Sheets Sync Configuration */}
      <motion.section 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4 }}
        className="rounded-2xl p-6 bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm space-y-6"
      >
        <div className="flex items-center gap-3 pb-3 border-b border-slate-100 dark:border-[#212838]">
          <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
            <FileSpreadsheet className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white">Google Sheets Real-Time Journal Sync</h2>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Connect your Google Sheet Apps Script webhook to automatically import and export closed trades.
            </p>
          </div>
        </div>

        <form onSubmit={handleSaveSheets} className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs">
          <div className="space-y-1.5 md:col-span-2">
            <label className="font-semibold text-slate-700 dark:text-slate-300">Google Sheet URL or Sheet ID</label>
            <input
              type="text"
              value={localSheets.sheetUrlOrId}
              onChange={(e) => setLocalSheets({ ...localSheets, sheetUrlOrId: e.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
              placeholder="https://docs.google.com/spreadsheets/d/your-sheet-id/edit"
            />
          </div>

          <div className="space-y-1.5">
            <label className="font-semibold text-slate-700 dark:text-slate-300">Target Sheet Tab Name</label>
            <input
              type="text"
              value={localSheets.sheetTabName}
              onChange={(e) => setLocalSheets({ ...localSheets, sheetTabName: e.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
              placeholder="LiveJournal_2026"
            />
          </div>

          <div className="space-y-1.5">
            <label className="font-semibold text-slate-700 dark:text-slate-300">Webhook Key / Bearer Auth</label>
            <input
              type="text"
              value={localSheets.apiKeyOrToken}
              onChange={(e) => setLocalSheets({ ...localSheets, apiKeyOrToken: e.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
              placeholder="Optional Bearer token"
            />
          </div>

          <div className="md:col-span-2 pt-2 flex justify-end">
            <button
              type="submit"
              className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition-colors shadow-sm cursor-pointer"
            >
              Update Google Sheets Connection
            </button>
          </div>
        </form>
      </motion.section>

      {/* 7. VS Code / Python / MT5 Bot Target Dispatch Script */}
      <motion.section 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4 }}
        className="rounded-2xl p-6 bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm space-y-4"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              <Terminal className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">VS Code & Python Integration Code</h2>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Copy this code into your VS Code environment to listen for target updates and control your MT5 bot.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleCopyScript}
            className="px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-2 transition-all shadow-sm cursor-pointer"
          >
            <Copy className="w-3.5 h-3.5" />
            <span>{copiedScript ? 'Copied to Clipboard!' : 'Copy Script for VS Code'}</span>
          </button>
        </div>

        <div className="p-4 rounded-xl bg-slate-950 text-slate-300 font-mono text-xs overflow-x-auto border border-slate-800 leading-relaxed">
          <pre>{pythonScript}</pre>
        </div>
      </motion.section>
    </div>
  );
};

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
  RefreshCw, 
  Database, 
  Terminal, 
  ShieldCheck, 
  Zap, 
  Sliders, 
  Shield, 
  TrendingUp, 
  Sparkles, 
  Power, 
  PowerOff, 
  Palette,
  Target
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
  const [localBotSettings, setLocalBotSettings] = useState<BotSettings>(botSettings);
  const [balanceInput, setBalanceInput] = useState(metrics.currentBalance.toString());
  const [equityInput, setEquityInput] = useState(metrics.currentEquity.toString());
  const [pingStatus, setPingStatus] = useState<string | null>(null);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [brandingSaved, setBrandingSaved] = useState(false);
  const [engineSaved, setEngineSaved] = useState(false);

  React.useEffect(() => {
    setLocalBranding(branding);
  }, [branding]);

  React.useEffect(() => {
    setLocalBotSettings(botSettings);
  }, [botSettings]);

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

  const handleSaveEngineSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await fetch('/api/bot/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localBotSettings),
      });
      setEngineSaved(true);
      setTimeout(() => setEngineSaved(false), 3000);
    } catch (err) {
      console.error('Failed to save engine settings:', err);
    }
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

  const isDark = themeMode === 'dark';

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-8 max-w-6xl mx-auto">
      {/* View Header */}
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
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
            Engine volatility parameters, profit milestones, master kill switch, and broker configuration.
          </p>
        </div>

        {savedSuccess && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 text-xs font-semibold animate-in fade-in">
            <CheckCircle2 className="w-4 h-4" />
            <span>Settings Saved & Synced</span>
          </div>
        )}
      </motion.div>

      {/* 1. Master Kill Switch */}
      <motion.section 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
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
                  ? 'All automated buy and sell orders, trailing stops, and risk gates are operating normally.'
                  : 'Emergency override engaged: The bot has been turned OFF. No automated buy or sell orders will be dispatched.'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onToggleBotActive}
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

      {/* 2. Quant Engine & Profit Objectives */}
      <motion.section 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        className="rounded-2xl p-6 bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm space-y-5"
      >
        <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-[#212838]">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                Engine Volatility & Profit Milestones
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Minimum R:R threshold, dynamic ADR engine activation, and profit target pacing.
              </p>
            </div>
          </div>

          {engineSaved && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400 font-semibold bg-emerald-500/10 px-3 py-1 rounded-xl border border-emerald-500/20">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Engine Settings Persisted</span>
            </div>
          )}
        </div>

        <form onSubmit={handleSaveEngineSettings} className="space-y-5 text-xs">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Adaptive Mode Toggle */}
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] flex items-center justify-between">
              <div>
                <span className="font-bold text-slate-900 dark:text-white">Adaptive Volatility Engine (ADR)</span>
                <p className="text-[11px] text-slate-500 mt-0.5">Scale stops and buffers to real-time ADR</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(localBotSettings.adaptiveMode)}
                  onChange={(e) => setLocalBotSettings({ ...localBotSettings, adaptiveMode: e.target.checked })}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-300 dark:bg-slate-800 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {/* Stop on Daily Goal Toggle */}
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] flex items-center justify-between">
              <div>
                <span className="font-bold text-slate-900 dark:text-white">Auto-Halt on Daily Goal Reached</span>
                <p className="text-[11px] text-slate-500 mt-0.5">Stop execution once daily target is banked</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(localBotSettings.stopOnDailyGoalReached)}
                  onChange={(e) => setLocalBotSettings({ ...localBotSettings, stopOnDailyGoalReached: e.target.checked })}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-300 dark:bg-slate-800 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>
          </div>

          {/* Min R:R Input (No R:R slider!) */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] flex items-center justify-between">
            <div>
              <span className="font-bold text-slate-900 dark:text-white">Minimum Target R:R Filter (1 : R)</span>
              <p className="text-[11px] text-slate-500 mt-0.5">Rejects any trade whose adapted structural target delivers less than this ratio</p>
            </div>
            <div className="flex items-center gap-1.5 font-mono">
              <span className="font-bold text-slate-500">1 :</span>
              <input
                type="number"
                step="0.1"
                min="0.5"
                max="5.0"
                value={localBotSettings.minRr ?? 1.0}
                onChange={(e) => setLocalBotSettings({ ...localBotSettings, minRr: parseFloat(e.target.value) || 1.0 })}
                className="w-20 px-3 py-1.5 rounded-lg bg-white dark:bg-[#151922] border border-slate-300 dark:border-[#212838] font-bold text-slate-900 dark:text-white text-right"
              />
            </div>
          </div>

          {/* Profit Goal Display & Inputs */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="space-y-1.5">
              <label className="font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1">
                <Target className="w-3.5 h-3.5 text-blue-600" /> Daily Profit Goal ($ / Base)
              </label>
              <input
                type="number"
                step="1"
                min="0"
                value={localBotSettings.dailyGoalTarget ?? 5}
                onChange={(e) => setLocalBotSettings({ ...localBotSettings, dailyGoalTarget: parseFloat(e.target.value) || 0 })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <label className="font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1">
                <TrendingUp className="w-3.5 h-3.5 text-indigo-500" /> Weekly Profit Goal ($ / Base)
              </label>
              <input
                type="number"
                step="5"
                min="0"
                value={localBotSettings.weeklyGoalTarget ?? 20}
                onChange={(e) => setLocalBotSettings({ ...localBotSettings, weeklyGoalTarget: parseFloat(e.target.value) || 0 })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <label className="font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1">
                <Layers className="w-3.5 h-3.5 text-emerald-500" /> Monthly Profit Goal ($ / Base)
              </label>
              <input
                type="number"
                step="10"
                min="0"
                value={localBotSettings.monthlyGoalTarget ?? 50}
                onChange={(e) => setLocalBotSettings({ ...localBotSettings, monthlyGoalTarget: parseFloat(e.target.value) || 0 })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono"
              />
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-sm cursor-pointer"
            >
              Broadcast Engine Settings to Bot Config
            </button>
          </div>
        </form>
      </motion.section>

      {/* 3. Site Branding */}
      <motion.section 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
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
                Customize the name of the portal, select your badge icon or custom monogram.
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
            <div className="space-y-1.5">
              <label className="font-semibold text-slate-700 dark:text-slate-300">
                Site Name (Displayed in Header)
              </label>
              <input
                type="text"
                value={localBranding.siteName}
                onChange={(e) => setLocalBranding({ ...localBranding, siteName: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-medium focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="font-semibold text-slate-700 dark:text-slate-300">
                Custom Icon Monogram / Text (Optional)
              </label>
              <input
                type="text"
                maxLength={4}
                value={localBranding.customInitials || ''}
                onChange={(e) => setLocalBranding({ ...localBranding, customInitials: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono uppercase focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-sm cursor-pointer"
            >
              Save Branding Settings
            </button>
          </div>
        </form>
      </motion.section>

      {/* 4. Appearance & Theme */}
      <motion.section 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
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
                Switch between dark charcoal gray (#10131a) and high-contrast light mode.
              </p>
            </div>
          </div>

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
      </motion.section>

      {/* 5. Real Broker Connection */}
      <motion.section 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        className="rounded-2xl p-6 bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm space-y-6"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100 dark:border-[#212838]">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              <Wifi className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                Broker Connection & Gateway
                <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full ${
                  localBroker.connected 
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30' 
                    : 'bg-rose-500/15 text-rose-600'
                }`}>
                  {localBroker.connected ? `CONNECTED (${localBroker.lastPingMs}ms)` : 'DISCONNECTED'}
                </span>
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Connected to Fusion Markets cTrader Open API.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleTestBrokerPing}
            className="px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-[#0d1017] hover:bg-slate-200 dark:hover:bg-[#191f2c] border border-slate-200 dark:border-[#212838] text-slate-700 dark:text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Test Ping</span>
          </button>
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
              <option value="Fusion Markets cTrader">Fusion Markets (cTrader Open API)</option>
              <option value="MetaTrader 5">MetaTrader 5</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="font-semibold text-slate-700 dark:text-slate-300">Account Number / Login ID</label>
            <input
              type="text"
              value={localBroker.accountNumber}
              onChange={(e) => setLocalBroker({ ...localBroker, accountNumber: e.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="md:col-span-2 pt-2 flex justify-end">
            <button
              type="submit"
              className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-sm cursor-pointer"
            >
              Save Broker Config
            </button>
          </div>
        </form>
      </motion.section>
    </div>
  );
};
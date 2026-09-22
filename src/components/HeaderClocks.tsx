import React, { useState, useEffect } from 'react';
import { 
  Clock, 
  ShieldCheck, 
  Activity, 
  Globe2, 
  Radio, 
  Sun, 
  Moon, 
  Wifi, 
  CheckCircle2, 
  Power, 
  PowerOff,
  TrendingUp,
  Shield,
  Bot,
  Zap,
  Terminal,
  Sparkles
} from 'lucide-react';
import { ThemeMode, BrokerConfig, SiteBrandingConfig } from '../types';
import { formatCurrency } from '../utils/currency';

interface SessionClockProps {
  botActive: boolean;
  onToggleBotActive?: () => void;
  themeMode: ThemeMode;
  onToggleTheme: (mode: ThemeMode) => void;
  currentEquity?: number;
  brokerConfig?: BrokerConfig;
  branding?: SiteBrandingConfig;
  onOpenBridge?: () => void;
}

export const HeaderClocks: React.FC<SessionClockProps> = ({
  botActive,
  onToggleBotActive,
  themeMode,
  onToggleTheme,
  currentEquity = 0,
  brokerConfig,
  branding,
  onOpenBridge,
}) => {
  const safeBranding: SiteBrandingConfig = {
    siteName: branding?.siteName || 'TRADING PORTAL',
    iconType: branding?.iconType || 'chart',
    customInitials: branding?.customInitials || '',
  };

  const safeBroker = brokerConfig || {
    connected: false,
    lastPingMs: 0,
    currency: 'USD',
  };
  const [times, setTimes] = useState({
    ny: '',
    london: '',
    sa: '',
    tokyo: '',
  });

  const [sessionStatuses, setSessionStatuses] = useState({
    ny: { isOpen: false, statusText: 'Pre-Market' },
    london: { isOpen: false, statusText: 'Closed' },
    sa: { isOpen: false, statusText: 'Closed' },
    tokyo: { isOpen: false, statusText: 'Closed' },
  });

  useEffect(() => {
    const updateClocks = () => {
      const now = new Date();

      const nyTime = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(now);

      const londonTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(now);

      const saTime = new Intl.DateTimeFormat('en-ZA', {
        timeZone: 'Africa/Johannesburg',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(now);

      const tokyoTime = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(now);

      setTimes({
        ny: nyTime,
        london: londonTime,
        sa: saTime,
        tokyo: tokyoTime,
      });

      const nyHour = parseInt(nyTime.split(':')[0], 10);
      const nyMin = parseInt(nyTime.split(':')[1], 10);
      const isNyOpen = (nyHour > 9 || (nyHour === 9 && nyMin >= 30)) && nyHour < 16;
      const isNyPre = (nyHour >= 7 && (nyHour < 9 || (nyHour === 9 && nyMin < 30)));

      const londonHour = parseInt(londonTime.split(':')[0], 10);
      const isLondonOpen = londonHour >= 8 && londonHour < 16;

      const saHour = parseInt(saTime.split(':')[0], 10);
      const isSaOpen = saHour >= 9 && saHour < 17;

      const tokyoHour = parseInt(tokyoTime.split(':')[0], 10);
      const isTokyoOpen = tokyoHour >= 9 && tokyoHour < 15;

      setSessionStatuses({
        ny: {
          isOpen: isNyOpen,
          statusText: isNyOpen ? 'OPEN' : isNyPre ? 'PRE-MKT' : 'CLOSED',
        },
        london: {
          isOpen: isLondonOpen,
          statusText: isLondonOpen ? 'OPEN' : 'CLOSED',
        },
        sa: {
          isOpen: isSaOpen,
          statusText: isSaOpen ? 'OPEN' : 'CLOSED',
        },
        tokyo: {
          isOpen: isTokyoOpen,
          statusText: isTokyoOpen ? 'OPEN' : 'CLOSED',
        },
      });
    };

    updateClocks();
    const interval = window.setInterval(updateClocks, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const isDark = themeMode === 'dark';

  // Render chosen branding icon
  const renderBrandingIcon = () => {
    switch (safeBranding.iconType) {
      case 'shield':
        return <Shield className="w-4 h-4 text-white" />;
      case 'bot':
        return <Bot className="w-4 h-4 text-white" />;
      case 'zap':
        return <Zap className="w-4 h-4 text-white" />;
      case 'gemini':
        return <Sparkles className="w-4 h-4 text-white" />;
      case 'terminal':
        return <Terminal className="w-4 h-4 text-white" />;
      case 'chart':
      default:
        return <TrendingUp className="w-4 h-4 text-white" />;
    }
  };

  return (
    <header className="h-16 bg-white dark:bg-[#10131a] border-b border-slate-300 dark:border-[#212838] px-4 sm:px-6 flex items-center justify-between z-30 shrink-0 select-none transition-colors duration-200">
      {/* Brand & Connection Status (MetaTrader 5 text removed under portal name) */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-blue-600 flex items-center justify-center font-bold text-white tracking-wider text-sm shadow-sm shrink-0">
            {safeBranding.customInitials ? safeBranding.customInitials : renderBrandingIcon()}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm tracking-tight text-black dark:text-white uppercase">
                {safeBranding.siteName || 'TRADING PORTAL'}
              </span>
              <span className="text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-mono">
                LIVE
              </span>
            </div>
            {/* Subtitle with live status and ping with direct bridge launcher */}
            <button
              type="button"
              onClick={onOpenBridge}
              className="flex items-center gap-2 text-[11px] text-black dark:text-slate-400 font-medium hover:text-blue-600 dark:hover:text-blue-400 transition-colors text-left cursor-pointer"
              title="Click to configure VS Code bot & live Broker integration"
            >
              <span className="flex items-center gap-1.5">
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${safeBroker.connected ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                {safeBroker.connected ? `Broker Connected (${safeBroker.currency || 'USD'})` : 'Broker Standby'}
              </span>
              <span className="text-slate-400 dark:text-slate-600">•</span>
              <span className="font-mono text-[10px]">{safeBroker.lastPingMs}ms</span>
            </button>
          </div>
        </div>
      </div>

      {/* Global Session Clocks (White bubbles in light mode with clear borders) */}
      <div className="hidden lg:flex items-center gap-2.5">
        {/* New York Clock */}
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-white dark:bg-[#151922] border border-slate-300 dark:border-[#212838] shadow-xs">
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase font-bold tracking-wider text-black dark:text-slate-400">New York</span>
              <span
                className={`text-[9px] font-semibold px-1.5 py-0.2 rounded font-mono ${
                  sessionStatuses.ny.isOpen
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30'
                    : sessionStatuses.ny.statusText === 'PRE-MKT'
                    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30'
                    : 'bg-slate-200 dark:bg-slate-800 text-black dark:text-slate-400'
                }`}
              >
                {sessionStatuses.ny.statusText}
              </span>
            </div>
            <span className="font-mono text-xs font-semibold text-black dark:text-slate-200">
              {times.ny || '--:--:--'} <span className="text-[10px] text-slate-500 dark:text-slate-400">EDT</span>
            </span>
          </div>
        </div>

        {/* London Clock */}
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-white dark:bg-[#151922] border border-slate-300 dark:border-[#212838] shadow-xs">
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase font-bold tracking-wider text-black dark:text-slate-400">London</span>
              <span
                className={`text-[9px] font-semibold px-1.5 py-0.2 rounded font-mono ${
                  sessionStatuses.london.isOpen
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30'
                    : 'bg-slate-200 dark:bg-slate-800 text-black dark:text-slate-400'
                }`}
              >
                {sessionStatuses.london.statusText}
              </span>
            </div>
            <span className="font-mono text-xs font-semibold text-black dark:text-slate-200">
              {times.london || '--:--:--'} <span className="text-[10px] text-slate-500 dark:text-slate-400">BST</span>
            </span>
          </div>
        </div>

        {/* South Africa Clock (Johannesburg SAST) */}
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-white dark:bg-[#151922] border border-slate-300 dark:border-[#212838] shadow-xs">
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase font-bold tracking-wider text-black dark:text-slate-400">South Africa</span>
              <span
                className={`text-[9px] font-semibold px-1.5 py-0.2 rounded font-mono ${
                  sessionStatuses.sa.isOpen
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30'
                    : 'bg-slate-200 dark:bg-slate-800 text-black dark:text-slate-400'
                }`}
              >
                {sessionStatuses.sa.statusText}
              </span>
            </div>
            <span className="font-mono text-xs font-semibold text-black dark:text-slate-200">
              {times.sa || '--:--:--'} <span className="text-[10px] text-slate-500 dark:text-slate-400">SAST</span>
            </span>
          </div>
        </div>

        {/* Tokyo Clock */}
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-white dark:bg-[#151922] border border-slate-300 dark:border-[#212838] shadow-xs">
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase font-bold tracking-wider text-black dark:text-slate-400">Tokyo</span>
              <span
                className={`text-[9px] font-semibold px-1.5 py-0.2 rounded font-mono ${
                  sessionStatuses.tokyo.isOpen
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30'
                    : 'bg-slate-200 dark:bg-slate-800 text-black dark:text-slate-400'
                }`}
              >
                {sessionStatuses.tokyo.statusText}
              </span>
            </div>
            <span className="font-mono text-xs font-semibold text-black dark:text-slate-200">
              {times.tokyo || '--:--:--'} <span className="text-[10px] text-slate-500 dark:text-slate-400">JST</span>
            </span>
          </div>
        </div>
      </div>

      {/* Account Info, Kill Switch & Theme Toggle */}
      <div className="flex items-center gap-2.5 sm:gap-3">
        <div className="hidden sm:flex items-center gap-2 text-right">
          <div>
            <div className="text-[10px] font-medium uppercase text-black dark:text-slate-400 tracking-wider">
              Live Equity
            </div>
            <div className="text-xs font-mono font-bold text-emerald-600 dark:text-emerald-400">
              {formatCurrency(currentEquity, safeBroker.currency)}
            </div>
          </div>
        </div>

        {/* Bridge Quick Launcher */}
        <button
          type="button"
          onClick={onOpenBridge}
          className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-white hover:bg-slate-100 dark:bg-[#151922] dark:hover:bg-[#1e2430] border border-slate-300 dark:border-[#212838] text-xs font-semibold text-black dark:text-slate-300 shadow-xs cursor-pointer"
          title="Open VS Code & Broker Gateway Bridge"
        >
          <Terminal className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
          <span>Bridge API</span>
        </button>

        <div className="h-6 w-px bg-slate-300 dark:bg-slate-800 hidden sm:block" />

        {/* Ever-Kill Switch for Bot */}
        <button
          type="button"
          onClick={onToggleBotActive}
          id="header-kill-switch-btn"
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border transition-all cursor-pointer ${
            botActive
              ? 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border-emerald-500/40 shadow-xs'
              : 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-700 dark:text-rose-400 border-rose-500/50'
          }`}
          title={botActive ? 'Click to trigger Emergency Kill Switch (Halt Bot)' : 'Click to Re-Arm Bot Execution'}
        >
          {botActive ? (
            <Power className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 animate-pulse" />
          ) : (
            <PowerOff className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
          )}
          <div className="flex flex-col text-left">
            <span className="text-[9px] uppercase font-bold text-black dark:text-slate-400 leading-none">KILL SWITCH</span>
            <span className="text-xs font-mono font-bold leading-tight">
              {botActive ? 'BOT ARMED' : 'BOT KILLED'}
            </span>
          </div>
        </button>

        {/* Quick Theme Switcher */}
        <button
          type="button"
          onClick={() => onToggleTheme(isDark ? 'light' : 'dark')}
          id="header-theme-toggle-btn"
          className="p-2.5 rounded-xl bg-white hover:bg-slate-100 dark:bg-[#151922] dark:hover:bg-[#1e2430] border border-slate-300 dark:border-[#212838] text-black dark:text-slate-300 transition-colors cursor-pointer shadow-xs"
          title={`Switch to ${isDark ? 'Light' : 'Dark'} Mode`}
        >
          {isDark ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-blue-600" />}
        </button>
      </div>
    </header>
  );
};

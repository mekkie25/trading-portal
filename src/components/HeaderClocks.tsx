import React, { useState, useEffect } from 'react';
import { 
  Menu,
  Sun, 
  Moon, 
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
  onToggleSidebar?: () => void;
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
  onToggleSidebar,
}) => {
  const safeBranding: SiteBrandingConfig = {
    siteName: branding?.siteName || 'TRADING PORTAL',
    iconType: branding?.iconType || 'chart',
    customInitials: branding?.customInitials || '',
  };

  const safeBroker = brokerConfig || {
    connected: true,
    lastPingMs: 0,
    currency: 'USD',
  };

  const [times, setTimes] = useState({ ny: '', london: '', sa: '', tokyo: '' });
  const [statuses, setStatuses] = useState({
    ny: 'CLOSED', london: 'CLOSED', sa: 'CLOSED', tokyo: 'CLOSED'
  });

  useEffect(() => {
    const updateClocks = () => {
      const now = new Date();
      const getT = (tz: string) =>
        new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);

      const nyTime = getT('America/New_York');
      const londonTime = getT('Europe/London');
      const saTime = getT('Africa/Johannesburg');
      const tokyoTime = getT('Asia/Tokyo');

      setTimes({ ny: nyTime, london: londonTime, sa: saTime, tokyo: tokyoTime });

      const nyH = parseInt(nyTime.split(':')[0], 10);
      const lonH = parseInt(londonTime.split(':')[0], 10);
      const saH = parseInt(saTime.split(':')[0], 10);
      const tokH = parseInt(tokyoTime.split(':')[0], 10);

      setStatuses({
        ny: nyH >= 9 && nyH < 16 ? 'OPEN' : 'CLOSED',
        london: lonH >= 8 && lonH < 16 ? 'OPEN' : 'CLOSED',
        sa: saH >= 9 && saH < 17 ? 'OPEN' : 'CLOSED',
        tokyo: tokH >= 9 && tokH < 15 ? 'OPEN' : 'CLOSED',
      });
    };
    updateClocks();
    const iv = setInterval(updateClocks, 1000);
    return () => clearInterval(iv);
  }, []);

  const isDark = themeMode === 'dark';

  return (
    <header className="h-16 bg-white dark:bg-[#10131a] border-b border-slate-300 dark:border-[#212838] px-3 sm:px-6 flex items-center justify-between z-30 shrink-0 select-none transition-colors">
      <div className="flex items-center gap-2 sm:gap-4">
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className="p-2 rounded-xl text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#151922] cursor-pointer lg:hidden"
            title="Toggle Menu"
          >
            <Menu className="w-5 h-5" />
          </button>
        )}

        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 sm:h-9 sm:w-9 rounded-xl bg-blue-600 flex items-center justify-center font-bold text-white text-xs sm:text-sm shrink-0">
            {safeBranding.customInitials ? safeBranding.customInitials : <TrendingUp className="w-4 h-4 text-white" />}
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-xs sm:text-sm tracking-tight text-black dark:text-white uppercase truncate max-w-[120px] sm:max-w-none">
                {safeBranding.siteName || 'TRADING PORTAL'}
              </span>
              <span className="text-[9px] font-semibold uppercase px-1.5 py-0.2 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-mono">
                LIVE
              </span>
            </div>
            <div className="flex items-center gap-1 text-[10px] text-slate-500 font-medium truncate">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span>Fusion Markets</span>
            </div>
          </div>
        </div>
      </div>

      {/* Clocks: Horizontal scrollable container that fits half-screen windows */}
      <div className="hidden md:flex items-center gap-2 overflow-x-auto py-1 max-w-[45vw]">
        {[
          { label: 'New York', t: times.ny, s: statuses.ny, tz: 'EDT' },
          { label: 'London', t: times.london, s: statuses.london, tz: 'BST' },
          { label: 'South Africa', t: times.sa, s: statuses.sa, tz: 'SAST' },
          { label: 'Tokyo', t: times.tokyo, s: statuses.tokyo, tz: 'JST' },
        ].map((c) => (
          <div key={c.label} className="flex items-center gap-1.5 px-2 py-1 rounded-xl bg-slate-50 dark:bg-[#151922] border border-slate-200 dark:border-[#212838] text-[10px] shrink-0">
            <span className="font-bold text-slate-700 dark:text-slate-300">{c.label}</span>
            <span className={`px-1 rounded text-[8px] font-bold ${c.s === 'OPEN' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-slate-200 dark:bg-slate-800 text-slate-500'}`}>
              {c.s}
            </span>
            <span className="font-mono text-slate-900 dark:text-slate-200">{c.t || '--:--'}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <div className="text-right mr-1">
          <div className="text-[9px] uppercase font-bold text-slate-400">Live Equity</div>
          <div className="text-xs sm:text-sm font-mono font-bold text-emerald-600 dark:text-emerald-400">
            {formatCurrency(currentEquity, safeBroker.currency)}
          </div>
        </div>

        <button
          type="button"
          onClick={onToggleBotActive}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border transition-all cursor-pointer ${
            botActive
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
              : 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/40'
          }`}
          title={botActive ? 'Click to trigger Emergency Kill Switch' : 'Click to re-arm bot'}
        >
          {botActive ? <Power className="w-3.5 h-3.5 animate-pulse" /> : <PowerOff className="w-3.5 h-3.5" />}
          <span className="text-[10px] font-mono font-bold hidden sm:inline">{botActive ? 'ARMED' : 'KILLED'}</span>
        </button>

        <button
          type="button"
          onClick={() => onToggleTheme(isDark ? 'light' : 'dark')}
          className="p-2 rounded-xl bg-slate-100 dark:bg-[#151922] border border-slate-200 dark:border-[#212838] text-slate-700 dark:text-slate-300 cursor-pointer"
        >
          {isDark ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-blue-600" />}
        </button>
      </div>
    </header>
  );
};
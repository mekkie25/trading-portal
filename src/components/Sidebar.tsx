import React from 'react';
import { 
  LayoutDashboard, 
  BookOpen, 
  ShieldAlert, 
  CalendarDays, 
  LineChart, 
  Settings as SettingsIcon,
  Bot,
  ExternalLink
} from 'lucide-react';
import { TabId, ThemeMode } from '../types';

interface SidebarProps {
  currentTab: TabId;
  onSelectTab: (tab: TabId) => void;
  botActive: boolean;
  themeMode?: ThemeMode;
}

interface NavItem {
  id: TabId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  subtext: string;
}

export const Sidebar: React.FC<SidebarProps> = ({ currentTab, onSelectTab, botActive }) => {
  const navItems: NavItem[] = [
    {
      id: 'dashboard',
      label: 'Dashboard & Analytics',
      icon: LayoutDashboard,
      subtext: 'Overview, equity & bot targets',
    },
    {
      id: 'journal',
      label: 'Trade Journal',
      icon: BookOpen,
      badge: 'LIVE',
      subtext: 'Google Sheets & PDF export',
    },
    {
      id: 'limits',
      label: 'Advanced Limits',
      icon: ShieldAlert,
      subtext: 'Circuit breakers & drawdowns',
    },
    {
      id: 'calendar',
      label: 'Economic Calendar',
      icon: CalendarDays,
      badge: 'MACRO',
      subtext: 'Grid macro & mentor insights',
    },
    {
      id: 'live_feed',
      label: 'Live Feed & Charts',
      icon: LineChart,
      badge: 'R_10',
      subtext: 'TradingView & technical feed',
    },
    {
      id: 'settings',
      label: 'Settings & Broker API',
      icon: SettingsIcon,
      subtext: 'Dark/light, MT5 & Sheets sync',
    },
  ];

  return (
    <aside className="w-64 bg-white dark:bg-[#10131a] border-r border-slate-300 dark:border-[#212838] flex flex-col justify-between shrink-0 h-full select-none transition-colors duration-200">
      {/* Navigation Group */}
      <div className="p-4">
        <div className="px-3 py-2 text-[10px] uppercase font-bold tracking-wider text-black dark:text-slate-400 flex items-center justify-between">
          <span>PORTAL MODULES</span>
          <span className="text-[9px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-mono">
            V3.5
          </span>
        </div>

        <nav className="space-y-1.5 mt-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentTab === item.id;
            return (
              <button
                key={item.id}
                id={`sidebar-tab-${item.id}`}
                onClick={() => onSelectTab(item.id)}
                className={`w-full group relative flex items-center gap-3 px-3.5 py-3 rounded-xl text-left transition-all duration-150 cursor-pointer ${
                  isActive
                    ? 'bg-blue-600/10 dark:bg-blue-600/15 text-blue-700 dark:text-white border border-blue-500/30 shadow-xs'
                    : 'text-black dark:text-slate-400 hover:text-black dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#151922] border border-transparent'
                }`}
              >
                {/* Active Indicator Bar */}
                {isActive && (
                  <div className="absolute left-0 top-2.5 bottom-2.5 w-1 rounded-r bg-blue-600" />
                )}

                <div
                  className={`p-2 rounded-lg transition-colors ${
                    isActive
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'bg-white dark:bg-[#151922] text-black dark:text-slate-400 group-hover:text-black dark:group-hover:text-slate-200 border border-slate-300 dark:border-[#212838]'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold truncate tracking-tight text-black dark:text-slate-200">{item.label}</span>
                    {item.badge && (
                      <span
                        className={`text-[9px] font-mono font-bold px-1.5 py-0.2 rounded ${
                          item.badge === 'MACRO'
                            ? 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border border-rose-500/30'
                            : item.badge === 'R_10'
                            ? 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border border-blue-500/30'
                            : 'bg-slate-200 dark:bg-slate-800 text-black dark:text-slate-300'
                        }`}
                      >
                        {item.badge}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-black dark:text-slate-400 truncate mt-0.5">{item.subtext}</p>
                </div>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Footer Info & Broker Connection Reference */}
      <div className="p-4 border-t border-slate-300 dark:border-[#212838] space-y-3 bg-white dark:bg-[#10131a]">
        {/* Risk & Execution status card */}
        <div className="p-3 rounded-xl bg-white dark:bg-[#151922] border border-slate-300 dark:border-[#212838] shadow-xs">
          <div className="flex items-center justify-between text-xs">
            <span className="text-black dark:text-slate-400 flex items-center gap-1.5 text-[11px] font-medium">
              <Bot className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /> Algorithmic Engine
            </span>
            <span
              className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                botActive
                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30'
                  : 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border border-rose-500/30'
              }`}
            >
              {botActive ? 'ACTIVE' : 'STANDBY'}
            </span>
          </div>
          <div className="mt-2 text-[10px] text-black dark:text-slate-400 font-mono flex justify-between">
            <span>Daily Drawdown:</span>
            <span className="text-emerald-600 dark:text-emerald-400 font-semibold">0.82% / 3.50%</span>
          </div>
        </div>

        {/* External Gateway Reference Link */}
        <a
          href="https://www.2gs-trading.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-between px-3.5 py-2 rounded-xl bg-white hover:bg-slate-100 dark:bg-[#151922] dark:hover:bg-[#1c222e] border border-slate-300 dark:border-[#212838] text-black dark:text-slate-400 hover:text-black dark:hover:text-slate-200 transition-colors text-xs shadow-xs"
        >
          <span className="flex items-center gap-1.5 text-[11px] font-medium">
            <span>2GS Ecosystem</span>
          </span>
          <ExternalLink className="w-3.5 h-3.5 text-slate-500" />
        </a>
      </div>
    </aside>
  );
};

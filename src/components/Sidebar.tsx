import React from 'react';
import { 
  LayoutDashboard, 
  BookOpen, 
  ShieldAlert, 
  CalendarDays, 
  LineChart, 
  Settings as SettingsIcon,
  Bot,
  X
  History
} from 'lucide-react';
import { TabId, ThemeMode } from '../types';

interface SidebarProps {
  currentTab: TabId;
  onSelectTab: (tab: TabId) => void;
  botActive: boolean;
  themeMode?: ThemeMode;
  isOpen?: boolean;
  onClose?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ 
  currentTab, 
  onSelectTab, 
  botActive,
  isOpen = true,
  onClose
}) => {
  const navItems = [
    { id: 'dashboard', label: 'Dashboard & Analytics', icon: LayoutDashboard, subtext: 'Overview, equity & bot targets' },
    { id: 'journal', label: 'Trade Journal', icon: BookOpen, badge: 'LIVE', subtext: 'cTrader history & PDF export' },
    { id: 'limits', label: 'Advanced Limits', icon: ShieldAlert, subtext: 'Circuit breakers & drawdowns' },
    { id: 'calendar', label: 'Economic Calendar', icon: CalendarDays, badge: 'MACRO', subtext: 'Grid macro & mentor insights' },
    { id: 'live_feed', label: 'Live Feed & Charts', icon: LineChart, badge: 'R_10', subtext: 'TradingView & technical feed' },
    { id: 'backtest', label: 'Backtest & Replay', icon: History, badge: 'AUDIT', subtext: 'Historical M5 replay & reports' },
    { id: 'settings', label: 'Settings & Broker API', icon: SettingsIcon, subtext: 'Dark/light & cTrader config' },
  ];

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && (
        <div 
          onClick={onClose}
          className="fixed inset-0 bg-black/40 z-40 lg:hidden backdrop-blur-xs"
        />
      )}

      <aside className={`
        fixed lg:static top-0 bottom-0 left-0 z-50
        w-64 bg-white dark:bg-[#10131a] border-r border-slate-300 dark:border-[#212838] 
        flex flex-col justify-between shrink-0 h-full select-none transition-transform duration-200
        ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        <div className="p-4">
          <div className="px-3 py-2 text-[10px] uppercase font-bold tracking-wider text-slate-500 flex items-center justify-between">
            <span>PORTAL MODULES</span>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 font-mono">V3.5</span>
              {onClose && (
                <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-black dark:hover:text-white lg:hidden">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          <nav className="space-y-1 mt-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = currentTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    onSelectTab(item.id as TabId);
                    if (onClose) onClose();
                  }}
                  className={`w-full relative flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all cursor-pointer ${
                    isActive
                      ? 'bg-blue-600/10 text-blue-700 dark:text-white border border-blue-500/30'
                      : 'text-slate-700 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-[#151922]'
                  }`}
                >
                  <div className={`p-1.5 rounded-lg ${isActive ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-[#151922]'}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold truncate text-slate-900 dark:text-slate-200">{item.label}</span>
                      {item.badge && (
                        <span className="text-[8px] font-mono font-bold px-1.5 py-0.2 rounded bg-blue-500/15 text-blue-600">
                          {item.badge}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="p-4 border-t border-slate-200 dark:border-[#212838] bg-white dark:bg-[#10131a] space-y-2">
          <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#151922] border border-slate-200 dark:border-[#212838] text-xs">
            <span className="flex items-center gap-2 text-[11px] font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-slate-900 dark:text-white">Fusion cTrader</span>
            </span>
            <span className="text-[10px] font-mono text-emerald-600 font-bold">ONLINE</span>
          </div>
        </div>
      </aside>
    </>
  );
};
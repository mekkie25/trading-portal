/**
 * BacktestView.tsx
 *
 * Top-level shell for the Backtest tab. Renders a fixed mode toggle at the
 * top and delegates to one of two panels below it:
 *
 *   - BacktestResearchPanel : the existing per-pair, per-strategy matrix.
 *                             Content is unchanged; only the file name and
 *                             the exported symbol name were changed in the
 *                             refactor.
 *
 *   - LiveSimReplay         : the new single-account portfolio replay.
 *
 * The two panels are completely independent. Each one owns its own outer
 * scroll container and its own header, so nothing in either needs to know
 * that the other exists.
 */

import React, { useState } from 'react';
import { FlaskConical, Wallet } from 'lucide-react';
import { ThemeMode } from '../../types';
import { BacktestResearchPanel } from './BacktestResearchPanel';
import { LiveSimReplay } from './LiveSimReplay';

interface BacktestViewProps {
  themeMode?: ThemeMode;
  brokerCurrency?: string;
}

type TopMode = 'research' | 'live';

export const BacktestView: React.FC<BacktestViewProps> = ({
  themeMode = 'dark',
  brokerCurrency = 'USD',
}) => {
  const [topMode, setTopMode] = useState<TopMode>('research');

  return (
    <div className="h-full flex flex-col">
      {/* Fixed mode toggle bar */}
      <div className="shrink-0 px-6 md:px-8 py-3 border-b border-slate-300 dark:border-[#1a2030] bg-white dark:bg-[#07090e]">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">
              Backtest Mode
            </span>
            <span
              className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                topMode === 'research'
                  ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20'
                  : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
              }`}
            >
              {topMode === 'research' ? 'STRATEGY RESEARCH' : 'LIVE BOT REPLAY'}
            </span>
          </div>

          <div className="flex items-center gap-1 p-1 rounded-2xl bg-slate-100 dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
            <button
              type="button"
              onClick={() => setTopMode('research')}
              className={`px-4 py-1.5 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${
                topMode === 'research'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-black dark:hover:text-white'
              }`}
            >
              <FlaskConical className="w-3.5 h-3.5" />
              <span>Strategy Research</span>
            </button>
            <button
              type="button"
              onClick={() => setTopMode('live')}
              className={`px-4 py-1.5 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${
                topMode === 'live'
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-black dark:hover:text-white'
              }`}
            >
              <Wallet className="w-3.5 h-3.5" />
              <span>Live Bot Replay</span>
            </button>
          </div>
        </div>
      </div>

      {/* Content — each panel keeps its own header and scroll container */}
      <div className="flex-1 overflow-hidden">
        {topMode === 'research' && (
          <BacktestResearchPanel
            themeMode={themeMode}
            brokerCurrency={brokerCurrency}
          />
        )}
        {topMode === 'live' && (
          <LiveSimReplay
            themeMode={themeMode}
            brokerCurrency={brokerCurrency}
          />
        )}
      </div>
    </div>
  );
};
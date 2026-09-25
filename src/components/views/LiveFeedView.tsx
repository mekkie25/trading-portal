import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { 
  Maximize2, 
  Minimize2, 
  Activity,
  Layers,
  Sparkles
} from 'lucide-react';
import { ThemeMode, TradeRecord } from '../../types';

interface LiveFeedViewProps {
  currentEquity: number;
  riskPerTradePct: number;
  themeMode?: ThemeMode;
  activeTrades?: TradeRecord[];
}

interface AssetOption {
  symbol: string;
  name: string;
  tvSymbol: string;
  category: string;
}

const WHITELISTED_CHART_ASSETS: AssetOption[] = [
  { symbol: 'US30', name: 'Wall Street 30 (Dow Jones)', tvSymbol: 'BLACKBULL:US30', category: 'Indices' },
  { symbol: 'GOLD', name: 'Gold Spot / U.S. Dollar', tvSymbol: 'OANDA:XAUUSD', category: 'Commodities' },
  { symbol: 'NAS100', name: 'US Tech 100 (NASDAQ)', tvSymbol: 'BLACKBULL:US100', category: 'Indices' },
  { symbol: 'GERMAN30', name: 'Germany 40 (DAX40)', tvSymbol: 'BLACKBULL:GER40', category: 'Indices' },
  { symbol: 'EURUSD', name: 'Euro / U.S. Dollar', tvSymbol: 'FX:EURUSD', category: 'Forex' },
  { symbol: 'USDJPY', name: 'U.S. Dollar / Japanese Yen', tvSymbol: 'FX:USDJPY', category: 'Forex' },
  { symbol: 'GBPUSD', name: 'British Pound / U.S. Dollar', tvSymbol: 'FX:GBPUSD', category: 'Forex' },
];

export const LiveFeedView: React.FC<LiveFeedViewProps> = ({ 
  currentEquity, 
  riskPerTradePct, 
  themeMode = 'dark'
}) => {
  const [selectedAsset, setSelectedAsset] = useState<AssetOption>(WHITELISTED_CHART_ASSETS[0]); // US30
  const [selectedInterval, setSelectedInterval] = useState<string>('5'); // 5M default
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const containerWrapperRef = useRef<HTMLDivElement>(null);

  // Full Screen API Handler
  const toggleFullscreen = () => {
    if (!containerWrapperRef.current) return;
    if (!document.fullscreenElement) {
      containerWrapperRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const isDark = themeMode === 'dark';

  // Construct secure, crash-proof embed URL
  const widgetUrl = `https://s.tradingview.com/widgetembed/?frameElementId=tradingview_widget&symbol=${encodeURIComponent(
    selectedAsset.tvSymbol
  )}&interval=${selectedInterval}&theme=${isDark ? 'dark' : 'light'}&style=1&timezone=Africa%2FJohannesburg&studies=%5B%22STD%3BEMA%22%2C%22STD%3BEMA%22%2C%22STD%3BVolume%22%5D&locale=en`;

  return (
    <div className={`h-full overflow-y-auto p-6 md:p-8 space-y-6 max-w-7xl mx-auto ${isFullscreen ? '!p-0 !m-0 !max-w-none' : ''}`}>
      {/* Header */}
      {!isFullscreen && (
        <motion.div 
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-300 dark:border-[#1a2030]"
        >
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-black dark:text-white flex items-center gap-2.5">
              Live Charting Terminal
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 font-medium font-mono">
                Real-Time Feeds
              </span>
            </h1>
            <p className="text-sm text-black dark:text-slate-400 mt-1">
              Zero login required. Real-time multi-timeframe candles across your 7 allowed assets.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleFullscreen}
              className="px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-2 shadow-xs cursor-pointer transition-colors"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span>Full Screen</span>
            </button>
          </div>
        </motion.div>
      )}

      {/* Asset Quick Switcher */}
      {!isFullscreen && (
        <div className="flex items-center gap-3 overflow-x-auto pb-1">
          {WHITELISTED_CHART_ASSETS.map((asset) => {
            const isSelected = selectedAsset.symbol === asset.symbol;
            return (
              <button
                key={asset.symbol}
                onClick={() => setSelectedAsset(asset)}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border transition-all shrink-0 text-left cursor-pointer ${
                  isSelected
                    ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                    : 'bg-white dark:bg-[#0f1118] text-slate-700 dark:text-slate-300 border-slate-300 dark:border-[#1a2030] hover:border-slate-400'
                }`}
              >
                <div className="flex flex-col">
                  <span className="text-xs font-bold font-mono">{asset.symbol}</span>
                  <span className={`text-[10px] ${isSelected ? 'text-blue-100' : 'text-slate-500'}`}>{asset.name}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Main Terminal Frame */}
      <div 
        ref={containerWrapperRef} 
        className={`rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs overflow-hidden flex flex-col relative ${
          isFullscreen ? 'w-screen h-screen !rounded-none !border-none' : 'min-h-[640px]'
        }`}
      >
        {/* Top Control Bar */}
        <div className="px-4 py-2.5 bg-white dark:bg-[#0b101a] border-b border-slate-200 dark:border-[#1a2030] flex flex-wrap items-center justify-between gap-3 text-xs shrink-0 select-none">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-bold text-black dark:text-white font-mono text-sm">
              {selectedAsset.symbol} • {selectedAsset.name}
            </span>

            {/* Timeframe Selector */}
            <div className="flex items-center bg-slate-100 dark:bg-[#08090d] p-0.5 rounded-lg border border-slate-300 dark:border-[#1a2030]">
              {[
                { label: '1m', val: '1' },
                { label: '5m', val: '5' },
                { label: '15m', val: '15' },
                { label: '30m', val: '30' },
                { label: '1h', val: '60' },
                { label: '4h', val: '240' },
                { label: '1D', val: 'D' },
              ].map((tf) => (
                <button
                  key={tf.val}
                  onClick={() => setSelectedInterval(tf.val)}
                  className={`px-2 py-0.5 text-[11px] font-mono font-bold rounded transition-all cursor-pointer ${
                    selectedInterval === tf.val ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-black dark:hover:text-white'
                  }`}
                >
                  {tf.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={toggleFullscreen}
              className="p-1.5 rounded-lg text-slate-500 hover:text-black dark:hover:text-white cursor-pointer"
              title={isFullscreen ? 'Exit Full Screen' : 'Enter Full Screen'}
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4 text-amber-400" /> : <Maximize2 className="w-4 h-4 text-blue-500" />}
            </button>
          </div>
        </div>

        {/* Secure Sandboxed Viewport: 100% immune to React render crashes */}
        <div className="flex-1 w-full h-full min-h-[580px] bg-white dark:bg-[#07090e]">
          <iframe
            key={`${selectedAsset.symbol}-${selectedInterval}-${themeMode}`}
            src={widgetUrl}
            className="w-full h-full border-0 block"
            title="Live Chart"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>
      </div>
    </div>
  );
};
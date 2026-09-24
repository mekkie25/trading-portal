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
  { symbol: 'GERMAN30', name: 'Germany 40 (DAX)', tvSymbol: 'BLACKBULL:GER40', category: 'Indices' },
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
  const chartContainerRef = useRef<HTMLDivElement>(null);
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

  // Mount TradingView's Full Advanced Platform Engine directly into the DOM
  useEffect(() => {
    if (!chartContainerRef.current) return;
    chartContainerRef.current.innerHTML = '';

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/tv.js';
    script.type = 'text/javascript';
    script.async = true;
    script.onload = () => {
      if (typeof (window as any).TradingView !== 'undefined' && chartContainerRef.current) {
        new (window as any).TradingView.widget({
          container_id: chartContainerRef.current.id,
          autosize: true,
          symbol: selectedAsset.tvSymbol,
          interval: selectedInterval,
          timezone: 'Africa/Johannesburg',
          theme: themeMode === 'dark' ? 'dark' : 'light',
          style: '1', // Candlesticks
          locale: 'en',
          toolbar_bg: themeMode === 'dark' ? '#0f1118' : '#ffffff',
          enable_publishing: false,
          allow_symbol_change: true,
          hide_side_toolbar: false, // FULL TRADINGVIEW DRAWING TOOLBAR ACTIVE
          withdateranges: true,
          save_image: true,
          studies: [
            'STD;EMA', // Default moving averages
            'STD;EMA',
            'STD;Volume'
          ],
          disabled_features: [
            'use_localstorage_for_settings'
          ],
          enabled_features: [
            'side_toolbar_in_fullscreen_mode',
            'header_in_fullscreen_mode'
          ],
          overrides: {
            'paneProperties.background': themeMode === 'dark' ? '#07090e' : '#ffffff',
            'paneProperties.vertGridProperties.color': themeMode === 'dark' ? '#141a26' : '#e2e8f0',
            'paneProperties.horzGridProperties.color': themeMode === 'dark' ? '#141a26' : '#e2e8f0',
            'scalesProperties.textColor': themeMode === 'dark' ? '#94a3b8' : '#000000',
            'mainSeriesProperties.candleStyle.upColor': '#10b981',
            'mainSeriesProperties.candleStyle.downColor': '#f43f5e',
            'mainSeriesProperties.candleStyle.drawWick': true,
            'mainSeriesProperties.candleStyle.drawBorder': true,
            'mainSeriesProperties.candleStyle.borderColor': '#374151',
            'mainSeriesProperties.candleStyle.borderUpColor': '#10b981',
            'mainSeriesProperties.candleStyle.borderDownColor': '#f43f5e',
            'mainSeriesProperties.candleStyle.wickUpColor': '#10b981',
            'mainSeriesProperties.candleStyle.wickDownColor': '#f43f5e',
          },
        });
      }
    };

    document.head.appendChild(script);

    return () => {
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
    };
  }, [selectedAsset.tvSymbol, selectedInterval, themeMode]);

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
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
                Advanced Platform
              </span>
            </h1>
            <p className="text-sm text-black dark:text-slate-400 mt-1">
              Institutional vector charting with full drawing suite, custom indicators, and multi-timeframe feeds.
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

      {/* Asset Quick Switcher Pills */}
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

      {/* High-Definition TradingView Terminal Container */}
      <div 
        ref={containerWrapperRef}
        className={`rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs overflow-hidden flex flex-col relative ${
          isFullscreen ? 'w-screen h-screen !rounded-none !border-none' : 'min-h-[640px]'
        }`}
      >
        {/* Top Minimal Strip */}
        <div className="px-4 py-2.5 bg-white dark:bg-[#0b101a] border-b border-slate-200 dark:border-[#1a2030] flex items-center justify-between text-xs shrink-0 select-none">
          <div className="flex items-center gap-3">
            <span className="font-bold text-black dark:text-white font-mono text-sm">
              {selectedAsset.symbol} • {selectedAsset.name}
            </span>
            <span className="text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20 font-mono">
              REAL-TIME
            </span>
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

        {/* The Native Advanced TradingView DOM Node */}
        <div 
          id="tv_chart_container" 
          ref={chartContainerRef} 
          className="flex-1 w-full h-full min-h-[580px]"
        />
      </div>
    </div>
  );
};
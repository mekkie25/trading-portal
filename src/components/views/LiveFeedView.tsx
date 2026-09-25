import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { 
  init, 
  dispose, 
  Chart, 
  KLineData 
} from 'klinecharts';
import { 
  Maximize2, 
  Minimize2, 
  Crosshair, 
  TrendingUp, 
  Minus, 
  Square, 
  Trash2, 
  Layers, 
  CheckCircle2
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
  derivSymbol: string;
  basePrice: number;
}

const ASSET_LIST: AssetOption[] = [
  { symbol: 'US30', name: 'Wall Street 30 (Dow Jones)', derivSymbol: 'OTC_DJI', basePrice: 45180.00 },
  { symbol: 'GOLD', name: 'Gold Spot / U.S. Dollar', derivSymbol: 'frxXAUUSD', basePrice: 2642.50 },
  { symbol: 'NAS100', name: 'US Tech 100 (NASDAQ)', derivSymbol: 'OTC_NDX', basePrice: 19880.00 },
  { symbol: 'GERMAN30', name: 'Germany 40 (DAX40)', derivSymbol: 'OTC_GDAXI', basePrice: 18620.00 },
  { symbol: 'EURUSD', name: 'Euro / U.S. Dollar', derivSymbol: 'frxEURUSD', basePrice: 1.08450 },
  { symbol: 'USDJPY', name: 'U.S. Dollar / Japanese Yen', derivSymbol: 'frxUSDJPY', basePrice: 143.420 },
  { symbol: 'GBPUSD', name: 'British Pound / U.S. Dollar', derivSymbol: 'frxGBPUSD', basePrice: 1.32150 },
];

export const LiveFeedView: React.FC<LiveFeedViewProps> = ({ 
  currentEquity, 
  riskPerTradePct, 
  themeMode = 'dark' 
}) => {
  const [selectedAsset, setSelectedAsset] = useState<AssetOption>(ASSET_LIST[0]);
  const [selectedInterval, setSelectedInterval] = useState<string>('5');
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [activeTool, setActiveTool] = useState<string>('pointer');
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  // Active Indicators State
  const [activeIndicators, setActiveIndicators] = useState({
    ema: true,
    boll: false,
    vol: true,
    rsi: true,
    macd: false,
  });

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartWrapperRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<Chart | null>(null);

  // Fullscreen toggle
  const toggleFullscreen = () => {
    if (!chartWrapperRef.current) return;
    if (!document.fullscreenElement) {
      chartWrapperRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  // Storage key for saving drawings permanently per asset
  const storageKey = `kline_persistent_drawings_${selectedAsset.symbol}`;

  // Save current overlays to localStorage
  const persistDrawings = (chart: Chart) => {
    try {
      const overlays = (chart as any).getOverlays ? (chart as any).getOverlays() : [];
      if (Array.isArray(overlays)) {
        const cleanOverlays = overlays.map((o: any) => ({
          name: o.name,
          points: o.points,
          styles: o.styles,
        }));
        localStorage.setItem(storageKey, JSON.stringify(cleanOverlays));
      }
    } catch {}
  };

  // Restore saved overlays from localStorage
  const restoreDrawings = (chart: Chart) => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const overlays = JSON.parse(saved);
        if (Array.isArray(overlays)) {
          overlays.forEach((o: any) => {
            chart.createOverlay({
              name: o.name,
              points: o.points,
              styles: o.styles,
              onDrawEnd: () => persistDrawings(chart),
              onPressedMoveEnd: () => persistDrawings(chart),
              onRemoved: () => persistDrawings(chart),
            });
          });
        }
      }
    } catch {}
  };

  // Generate initial candle series
  const generateInitialData = (basePrice: number, count: number = 100): KLineData[] => {
    const data: KLineData[] = [];
    let current = basePrice * 0.985;
    const now = Date.now();
    const stepMs = (parseInt(selectedInterval) || 5) * 60 * 1000;

    for (let i = count; i >= 0; i--) {
      const timestamp = now - (i * stepMs);
      const volatility = basePrice * 0.0028;
      const change = (Math.random() - 0.49) * volatility;
      const open = current;
      const close = open + change;
      const high = Math.max(open, close) + Math.random() * (volatility * 0.6);
      const low = Math.min(open, close) - Math.random() * (volatility * 0.6);
      const volume = Math.floor(200 + Math.random() * 800);

      data.push({
        timestamp,
        open: Number(open.toFixed(2)),
        high: Number(high.toFixed(2)),
        low: Number(low.toFixed(2)),
        close: Number(close.toFixed(2)),
        volume,
      });
      current = close;
    }
    return data;
  };

  // Mount & Initialize KLineChart with full persistence
  useEffect(() => {
    if (!chartContainerRef.current) return;
    const container = chartContainerRef.current;
    const isLight = themeMode !== 'dark';

    // Dispose any previous instance safely
    try {
      dispose(container);
    } catch {}

    const chart = init(container, {
      styles: {
        grid: {
          horizontal: { color: isLight ? '#f1f5f9' : '#141a26' },
          vertical: { color: isLight ? '#f1f5f9' : '#141a26' },
        },
        candle: {
          bar: {
            upColor: '#10b981',
            downColor: '#ef4444',
            upBorderColor: '#10b981',
            downBorderColor: '#ef4444',
            upWickColor: '#10b981',
            downWickColor: '#ef4444',
          },
          priceMark: {
            last: {
              show: true,
              upColor: '#10b981',
              downColor: '#ef4444',
              line: { show: true, style: 'dashed', dashedValue: [4, 4] },
              text: { show: true, color: '#ffffff' }
            }
          }
        },
        yAxis: {
          color: isLight ? '#94a3b8' : '#64748b',
          tickText: { color: isLight ? '#475569' : '#94a3b8', size: 11 }
        },
        xAxis: {
          color: isLight ? '#94a3b8' : '#64748b',
          tickText: { color: isLight ? '#475569' : '#94a3b8', size: 11 }
        }
      }
    });

    if (!chart) return;
    chartInstanceRef.current = chart;

    // Apply data & restore permanent drawings from localStorage
    const initialData = generateInitialData(selectedAsset.basePrice, 100);
    chart.applyNewData(initialData);
    restoreDrawings(chart);

    // Initial Indicators
    if (activeIndicators.ema) {
      chart.createIndicator('EMA', false, { id: 'candle_pane' });
    }
    if (activeIndicators.vol) {
      chart.createIndicator('VOL', false);
    }
    if (activeIndicators.rsi) {
      chart.createIndicator('RSI', false);
    }

    // 1-Second Candle Formation Heartbeat
    const tickInterval = window.setInterval(() => {
      const dataList = chart.getDataList();
      if (!dataList || dataList.length === 0) return;
      
      const last = { ...dataList[dataList.length - 1] };
      const move = (Math.random() - 0.495) * (selectedAsset.basePrice * 0.0004);
      const newClose = Number((last.close + move).toFixed(2));

      chart.updateData({
        ...last,
        close: newClose,
        high: Math.max(last.high, newClose),
        low: Math.min(last.low, newClose),
        volume: (last.volume || 100) + Math.floor(Math.random() * 5 + 1),
      });
    }, 1000);

    return () => {
      window.clearInterval(tickInterval);
      try {
        dispose(container);
      } catch {}
      chartInstanceRef.current = null;
    };
  }, [selectedAsset.symbol, selectedInterval, themeMode]);

  // Indicator Toggle Handlers (Unlimited!)
  const toggleIndicator = (name: 'ema' | 'boll' | 'vol' | 'rsi' | 'macd') => {
    const chart = chartInstanceRef.current;
    if (!chart) return;

    const nextState = !activeIndicators[name];
    setActiveIndicators(prev => ({ ...prev, [name]: nextState }));

    const indName = name.toUpperCase();
    if (nextState) {
      if (name === 'ema' || name === 'boll') {
        chart.createIndicator(indName, false, { id: 'candle_pane' });
      } else {
        chart.createIndicator(indName, false);
      }
    } else {
      chart.removeIndicator('candle_pane', indName);
      chart.removeIndicator(indName);
    }
  };

  // Drawing Tools Handlers with Automatic Permanent Saving
  const handleSelectTool = (toolName: string) => {
    setActiveTool(toolName);
    const chart = chartInstanceRef.current;
    if (!chart || toolName === 'pointer') return;

    let overlayType = 'segment';
    if (toolName === 'trendline') overlayType = 'segment';
    else if (toolName === 'ray') overlayType = 'rayLine';
    else if (toolName === 'horizontal') overlayType = 'horizontalStraightLine';
    else if (toolName === 'rect') overlayType = 'rect';
    else if (toolName === 'fibonacci') overlayType = 'fibonacci';

    chart.createOverlay({
      name: overlayType,
      onDrawEnd: () => {
        persistDrawings(chart);
        setSaveNotice('Drawing saved to chart memory!');
        setTimeout(() => setSaveNotice(null), 2500);
      },
      onPressedMoveEnd: () => {
        persistDrawings(chart);
      },
      onRemoved: () => {
        persistDrawings(chart);
      }
    });
  };

  // Clear All Drawings
  const handleClearDrawings = () => {
    const chart = chartInstanceRef.current;
    if (chart) {
      chart.removeOverlay();
      localStorage.removeItem(storageKey);
      setSaveNotice('Drawings cleared.');
      setTimeout(() => setSaveNotice(null), 2500);
    }
  };

  return (
    <div className={`h-full overflow-y-auto p-6 md:p-8 space-y-6 max-w-7xl mx-auto ${isFullscreen ? '!p-0 !m-0 !max-w-none' : ''}`}>
      {/* Toast Notice */}
      {saveNotice && (
        <div className="fixed top-20 right-8 z-50 p-3 rounded-xl bg-blue-600 text-white shadow-xl flex items-center gap-2 text-xs font-semibold animate-in fade-in border border-blue-400">
          <CheckCircle2 className="w-4 h-4 text-emerald-300" />
          <span>{saveNotice}</span>
        </div>
      )}

      {/* Top Header */}
      {!isFullscreen && (
        <motion.div 
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-300 dark:border-[#1a2030]"
        >
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-black dark:text-white flex items-center gap-2.5">
              KLine Charting Suite
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 font-medium font-mono">
                Persistent Memory Active
              </span>
            </h1>
            <p className="text-sm text-black dark:text-slate-400 mt-1">
              Independent vector charting. Drawings are permanently saved and will remain across restarts until you delete them.
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

      {/* Asset Switcher */}
      {!isFullscreen && (
        <div className="flex items-center gap-3 overflow-x-auto pb-1">
          {ASSET_LIST.map((asset) => {
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

      {/* Main KLineChart Frame */}
      <div 
        ref={chartWrapperRef} 
        className={`rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs overflow-hidden flex flex-col relative ${
          isFullscreen ? 'w-screen h-screen !rounded-none !border-none' : 'min-h-[620px]'
        }`}
      >
        {/* Top Controls Toolbar */}
        <div className="px-4 py-2.5 bg-white dark:bg-[#0b101a] border-b border-slate-200 dark:border-[#1a2030] flex flex-wrap items-center justify-between gap-3 text-xs shrink-0 select-none">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-bold text-black dark:text-white font-mono text-sm">
              {selectedAsset.symbol} • {selectedAsset.name}
            </span>

            {/* Timeframe Selector */}
            <div className="flex items-center bg-slate-100 dark:bg-[#08090d] p-0.5 rounded-lg border border-slate-300 dark:border-[#1a2030]">
              {['1', '5', '15', '30', '60', '240', 'D'].map((tf) => (
                <button
                  key={tf}
                  onClick={() => setSelectedInterval(tf)}
                  className={`px-2 py-0.5 text-[11px] font-mono font-bold rounded transition-all cursor-pointer ${
                    selectedInterval === tf ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-black dark:hover:text-white'
                  }`}
                >
                  {tf === '60' ? '1h' : tf === '240' ? '4h' : tf === 'D' ? '1D' : `${tf}m`}
                </button>
              ))}
            </div>
          </div>

          {/* Indicator Toggles */}
          <div className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono">
            <button
              onClick={() => toggleIndicator('ema')}
              className={`px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                activeIndicators.ema ? 'bg-cyan-500/15 text-cyan-500 border-cyan-500/30 font-bold' : 'text-slate-500 border-transparent hover:text-slate-300'
              }`}
            >
              EMA
            </button>
            <button
              onClick={() => toggleIndicator('boll')}
              className={`px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                activeIndicators.boll ? 'bg-amber-500/15 text-amber-500 border-amber-500/30 font-bold' : 'text-slate-500 border-transparent hover:text-slate-300'
              }`}
            >
              BOLL
            </button>
            <button
              onClick={() => toggleIndicator('vol')}
              className={`px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                activeIndicators.vol ? 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30 font-bold' : 'text-slate-500 border-transparent hover:text-slate-300'
              }`}
            >
              VOL
            </button>
            <button
              onClick={() => toggleIndicator('rsi')}
              className={`px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                activeIndicators.rsi ? 'bg-indigo-500/15 text-indigo-500 border-indigo-500/30 font-bold' : 'text-slate-500 border-transparent hover:text-slate-300'
              }`}
            >
              RSI
            </button>
            <button
              onClick={() => toggleIndicator('macd')}
              className={`px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                activeIndicators.macd ? 'bg-purple-500/15 text-purple-500 border-purple-500/30 font-bold' : 'text-slate-500 border-transparent hover:text-slate-300'
              }`}
            >
              MACD
            </button>

            {/* Fullscreen Button */}
            <button
              onClick={toggleFullscreen}
              className="p-1 rounded-lg text-slate-500 hover:text-black dark:hover:text-white cursor-pointer ml-1"
              title={isFullscreen ? 'Exit Full Screen' : 'Enter Full Screen'}
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4 text-amber-400" /> : <Maximize2 className="w-4 h-4 text-blue-500" />}
            </button>
          </div>
        </div>

        {/* Chart Viewport + Left Drawing Toolbar */}
        <div className="flex-1 w-full flex relative min-h-[540px]">
          {/* LEFT DRAWING TOOLBAR */}
          <div className="w-12 bg-white dark:bg-[#0b101a] border-r border-slate-300 dark:border-[#1a2030] flex flex-col items-center py-3 gap-2 shrink-0 select-none z-10">
            <button
              onClick={() => handleSelectTool('pointer')}
              className={`p-2 rounded-xl transition-colors cursor-pointer ${
                activeTool === 'pointer' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-black dark:hover:text-white'
              }`}
              title="Pointer / Crosshair"
            >
              <Crosshair className="w-4 h-4" />
            </button>

            <button
              onClick={() => handleSelectTool('trendline')}
              className={`p-2 rounded-xl transition-colors cursor-pointer ${
                activeTool === 'trendline' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-black dark:hover:text-white'
              }`}
              title="Draw Trendline (Saves Permanently)"
            >
              <TrendingUp className="w-4 h-4" />
            </button>

            <button
              onClick={() => handleSelectTool('ray')}
              className={`p-2 rounded-xl transition-colors cursor-pointer ${
                activeTool === 'ray' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-black dark:hover:text-white'
              }`}
              title="Draw Ray Line (Saves Permanently)"
            >
              <Minus className="w-4 h-4 rotate-45" />
            </button>

            <button
              onClick={() => handleSelectTool('horizontal')}
              className={`p-2 rounded-xl transition-colors cursor-pointer ${
                activeTool === 'horizontal' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-black dark:hover:text-white'
              }`}
              title="Horizontal Support/Resistance Line (Saves Permanently)"
            >
              <Minus className="w-4 h-4" />
            </button>

            <button
              onClick={() => handleSelectTool('rect')}
              className={`p-2 rounded-xl transition-colors cursor-pointer ${
                activeTool === 'rect' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-black dark:hover:text-white'
              }`}
              title="Draw Rectangle / Order Block Zone (Saves Permanently)"
            >
              <Square className="w-4 h-4" />
            </button>

            <button
              onClick={() => handleSelectTool('fibonacci')}
              className={`p-2 rounded-xl transition-colors cursor-pointer ${
                activeTool === 'fibonacci' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-black dark:hover:text-white'
              }`}
              title="Fibonacci Retracement (Saves Permanently)"
            >
              <Layers className="w-4 h-4" />
            </button>

            <div className="w-6 h-px bg-slate-200 dark:bg-slate-800 my-1" />

            <button
              onClick={handleClearDrawings}
              className="p-2 rounded-xl text-slate-500 hover:text-rose-600 transition-colors cursor-pointer"
              title="Clear All Saved Drawings for this Asset"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          {/* KLineChart DOM Container */}
          <div 
            ref={chartContainerRef} 
            className="flex-1 w-full h-full min-h-[520px] bg-white dark:bg-[#07090e]"
          />
        </div>
      </div>
    </div>
  );
};
import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { 
  createChart, 
  IChartApi, 
  ISeriesApi, 
  ColorType, 
  LineStyle,
  UTCTimestamp
} from 'lightweight-charts';
import { 
  Maximize2, 
  Minimize2, 
  RefreshCw
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
  decimals: number;
}

const ASSET_LIST: AssetOption[] = [
  { symbol: 'US30', name: 'Wall Street 30 (Dow Jones)', decimals: 1 },
  { symbol: 'GOLD', name: 'Gold Spot / U.S. Dollar', decimals: 2 },
  { symbol: 'NAS100', name: 'US Tech 100 (NASDAQ)', decimals: 1 },
  { symbol: 'GERMAN30', name: 'Germany 40 (DAX40)', decimals: 1 },
  { symbol: 'EURUSD', name: 'Euro / U.S. Dollar', decimals: 5 },
  { symbol: 'USDJPY', name: 'U.S. Dollar / Japanese Yen', decimals: 3 },
  { symbol: 'GBPUSD', name: 'British Pound / U.S. Dollar', decimals: 5 },
];

function calculateEMASeries(candles: { time: UTCTimestamp; close: number }[], period: number) {
  const k = 2 / (period + 1);
  const result: { time: UTCTimestamp; value: number }[] = [];
  let prevEma: number | null = null;

  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) continue;
    if (prevEma === null) {
      const sum = candles.slice(i - period + 1, i + 1).reduce((acc, c) => acc + c.close, 0);
      prevEma = sum / period;
    } else {
      prevEma = (candles[i].close - prevEma) * k + prevEma;
    }
    result.push({ time: candles[i].time, value: Number(prevEma.toFixed(4)) });
  }
  return result;
}

export const LiveFeedView: React.FC<LiveFeedViewProps> = ({ 
  currentEquity, 
  riskPerTradePct, 
  themeMode = 'dark',
  activeTrades = []
}) => {
  const [selectedAsset, setSelectedAsset] = useState<AssetOption>(ASSET_LIST[0]);
  const [selectedInterval, setSelectedInterval] = useState<string>('5');
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [lastPrice, setLastPrice] = useState<number>(0);

  const [showEma20, setShowEma20] = useState(true);
  const [showEma50, setShowEma50] = useState(true);
  const [showEma200, setShowEma200] = useState(true);
  const [showVolume, setShowVolume] = useState(true);
  const [showAsiaLevels, setShowAsiaLevels] = useState(true);

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartWrapperRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

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

  useEffect(() => {
    if (!chartContainerRef.current) return;
    const container = chartContainerRef.current;
    container.innerHTML = '';

    const isLight = themeMode !== 'dark';

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight || 560,
      layout: {
        background: { type: ColorType.Solid, color: isLight ? '#ffffff' : '#07090e' },
        textColor: isLight ? '#334155' : '#94a3b8',
      },
      grid: {
        vertLines: { color: isLight ? '#f1f5f9' : '#141a26' },
        horzLines: { color: isLight ? '#f1f5f9' : '#141a26' },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: isLight ? '#cbd5e1' : '#212838' },
      timeScale: {
        borderColor: isLight ? '#cbd5e1' : '#212838',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    chartApiRef.current = chart;

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderUpColor: '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
      priceFormat: {
        type: 'price',
        precision: selectedAsset.decimals,
        minMove: 1 / Math.pow(10, selectedAsset.decimals),
      },
    });
    candleSeriesRef.current = candleSeries;

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    const ema20Series = chart.addLineSeries({ color: '#06b6d4', lineWidth: 1.5, title: 'EMA 20' });
    const ema50Series = chart.addLineSeries({ color: '#f59e0b', lineWidth: 1.5, title: 'EMA 50' });
    const ema200Series = chart.addLineSeries({ color: '#a855f7', lineWidth: 2, title: 'EMA 200' });

    const loadRealData = async () => {
      setIsLoading(true);
      try {
        const res = await fetch(`/api/market/candles?symbol=${encodeURIComponent(selectedAsset.symbol)}`);
        if (!res.ok) return;

        const json = await res.json();
        const rawCandles = json.data || [];

        if (rawCandles.length === 0) return;

        const seen = new Set<number>();
        const formattedCandles: any[] = [];
        const formattedVolume: any[] = [];

        rawCandles.forEach((c: any) => {
          const t = Number(c.time);
          if (!seen.has(t) && !isNaN(t)) {
            seen.add(t);
            formattedCandles.push({
              time: t as UTCTimestamp,
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
            });
            formattedVolume.push({
              time: t as UTCTimestamp,
              value: Number(c.volume || 100),
              color: Number(c.close) >= Number(c.open) ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)',
            });
          }
        });

        formattedCandles.sort((a, b) => (a.time as number) - (b.time as number));
        formattedVolume.sort((a, b) => (a.time as number) - (b.time as number));

        candleSeries.setData(formattedCandles);
        if (showVolume) volumeSeries.setData(formattedVolume);

        if (formattedCandles.length > 0) {
          setLastPrice(formattedCandles[formattedCandles.length - 1].close);
        }

        if (showEma20) ema20Series.setData(calculateEMASeries(formattedCandles, 20));
        if (showEma50) ema50Series.setData(calculateEMASeries(formattedCandles, 50));
        if (showEma200) ema200Series.setData(calculateEMASeries(formattedCandles, 200));

        if (showAsiaLevels && formattedCandles.length > 20) {
          const recent = formattedCandles.slice(-40);
          const maxHigh = Math.max(...recent.map(c => c.high));
          const minLow = Math.min(...recent.map(c => c.low));
          const eqPrice = Number(((maxHigh + minLow) / 2).toFixed(selectedAsset.decimals));

          candleSeries.createPriceLine({
            price: maxHigh,
            color: '#3b82f6',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'ASIA HIGH',
          });

          candleSeries.createPriceLine({
            price: minLow,
            color: '#3b82f6',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'ASIA LOW',
          });

          candleSeries.createPriceLine({
            price: eqPrice,
            color: '#f59e0b',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'DAILY EQ (50%)',
          });
        }

        if (activeTrades.length > 0) {
          const markers: any[] = [];
          activeTrades.forEach(tr => {
            if (tr.asset.toUpperCase().includes(selectedAsset.symbol)) {
              const tradeTimestamp = Math.floor(new Date(tr.openTime).getTime() / 1000);
              markers.push({
                time: tradeTimestamp as UTCTimestamp,
                position: tr.type === 'BUY' ? 'belowBar' : 'aboveBar',
                color: tr.type === 'BUY' ? '#10b981' : '#ef4444',
                shape: tr.type === 'BUY' ? 'arrowUp' : 'arrowDown',
                text: `${tr.type} ${selectedAsset.symbol} | ${tr.strategy || 'BOT'}`,
              });
            }
          });
          if (markers.length > 0) {
            markers.sort((a, b) => (a.time as number) - (b.time as number));
            candleSeries.setMarkers(markers);
          }
        }
      } catch (err) {
        console.warn('Candle feed poll error:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadRealData();
    const intervalId = window.setInterval(loadRealData, 4000);

    const handleResize = () => {
      if (chart && container) {
        chart.applyOptions({
          width: container.clientWidth,
          height: container.clientHeight || 560,
        });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartApiRef.current = null;
    };
  }, [selectedAsset.symbol, selectedInterval, themeMode, showEma20, showEma50, showEma200, showVolume, showAsiaLevels]);

  return (
    <div className={`h-full overflow-y-auto p-6 md:p-8 space-y-6 max-w-7xl mx-auto ${isFullscreen ? '!p-0 !m-0 !max-w-none' : ''}`}>
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
                Fusion Markets cTrader Feed
              </span>
            </h1>
            <p className="text-sm text-black dark:text-slate-400 mt-1">
              Synchronized directly with your live engine. Clean vector candles, Asia session boundaries, and trade execution markers.
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

      <div 
        ref={chartWrapperRef} 
        className={`rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs overflow-hidden flex flex-col relative ${
          isFullscreen ? 'w-screen h-screen !rounded-none !border-none' : 'min-h-[640px]'
        }`}
      >
        <div className="px-4 py-2.5 bg-white dark:bg-[#0b101a] border-b border-slate-200 dark:border-[#1a2030] flex flex-wrap items-center justify-between gap-3 text-xs shrink-0 select-none">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-bold text-black dark:text-white font-mono text-sm">
              {selectedAsset.symbol} • {selectedAsset.name}
            </span>
            {lastPrice > 0 && (
              <span className="font-mono text-xs font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded">
                ${lastPrice.toFixed(selectedAsset.decimals)}
              </span>
            )}
            {isLoading && (
              <RefreshCw className="w-3.5 h-3.5 text-blue-500 animate-spin" />
            )}

            <div className="flex items-center bg-slate-100 dark:bg-[#08090d] p-0.5 rounded-lg border border-slate-300 dark:border-[#1a2030]">
              {['1', '5', '15', '60', '240', 'D'].map((tf) => (
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

          <div className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono">
            <button
              onClick={() => setShowAsiaLevels(!showAsiaLevels)}
              className={`px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                showAsiaLevels ? 'bg-blue-500/15 text-blue-600 border-blue-500/30 font-bold' : 'text-slate-500 border-transparent'
              }`}
            >
              🌙 ASIA RANGE
            </button>
            <button
              onClick={() => setShowEma20(!showEma20)}
              className={`px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                showEma20 ? 'bg-cyan-500/15 text-cyan-500 border-cyan-500/30 font-bold' : 'text-slate-500 border-transparent'
              }`}
            >
              EMA 20
            </button>
            <button
              onClick={() => setShowEma50(!showEma50)}
              className={`px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                showEma50 ? 'bg-amber-500/15 text-amber-500 border-amber-500/30 font-bold' : 'text-slate-500 border-transparent'
              }`}
            >
              EMA 50
            </button>
            <button
              onClick={() => setShowEma200(!showEma200)}
              className={`px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                showEma200 ? 'bg-purple-500/15 text-purple-500 border-purple-500/30 font-bold' : 'text-slate-500 border-transparent'
              }`}
            >
              EMA 200
            </button>
            <button
              onClick={() => setShowVolume(!showVolume)}
              className={`px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                showVolume ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30 font-bold' : 'text-slate-500 border-transparent'
              }`}
            >
              VOL
            </button>

            <button
              onClick={toggleFullscreen}
              className="p-1 rounded-lg text-slate-500 hover:text-black dark:hover:text-white cursor-pointer ml-1"
              title={isFullscreen ? 'Exit Full Screen' : 'Enter Full Screen'}
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4 text-amber-400" /> : <Maximize2 className="w-4 h-4 text-blue-500" />}
            </button>
          </div>
        </div>

        <div 
          ref={chartContainerRef} 
          className="flex-1 w-full h-full min-h-[580px] bg-white dark:bg-[#07090e]"
        />
      </div>
    </div>
  );
};
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion } from 'motion/react';
import { 
  Calculator, 
  TrendingUp, 
  TrendingDown, 
  Search,
  Activity,
  Layers,
  Sparkles,
  RefreshCw,
  Eye,
  Sliders,
  CheckCircle2,
  Maximize2
} from 'lucide-react';
import { MARKET_ASSETS } from '../../data/mockTradingData';
import { MarketAsset, ThemeMode } from '../../types';

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface LiveFeedViewProps {
  currentEquity: number;
  riskPerTradePct: number;
  themeMode?: ThemeMode;
}

// Generate realistic synthetic OHLC series for any asset and timeframe
function generateCandleData(basePrice: number, count: number = 60, intervalStr: string = '15'): Candle[] {
  const candles: Candle[] = [];
  let current = basePrice * 0.96;
  const now = Date.now();
  const stepMinutes = intervalStr === '1' ? 1 : intervalStr === '5' ? 5 : intervalStr === '60' ? 60 : intervalStr === '240' ? 240 : intervalStr === 'D' ? 1440 : 15;
  const stepMs = stepMinutes * 60 * 1000;

  for (let i = count; i >= 0; i--) {
    const timestamp = new Date(now - i * stepMs);
    const volatility = basePrice * 0.0035;
    const change = (Math.random() - 0.48) * volatility;
    const open = current;
    const close = open + change;
    const high = Math.max(open, close) + Math.random() * (volatility * 0.8);
    const low = Math.min(open, close) - Math.random() * (volatility * 0.8);
    const volume = Math.floor(200 + Math.random() * 850);

    candles.push({
      time: timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume,
    });
    current = close;
  }
  return candles;
}

// Compute Exponential Moving Average (EMA)
function calculateEMA(candles: Candle[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const emaArray: (number | null)[] = [];
  let prevEma: number | null = null;

  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      emaArray.push(null);
    } else if (i === period - 1) {
      const sum = candles.slice(0, period).reduce((acc, c) => acc + c.close, 0);
      prevEma = sum / period;
      emaArray.push(prevEma);
    } else if (prevEma !== null) {
      prevEma = (candles[i].close - prevEma) * k + prevEma;
      emaArray.push(prevEma);
    } else {
      emaArray.push(null);
    }
  }
  return emaArray;
}

// Compute Relative Strength Index (RSI 14)
function calculateRSI(candles: Candle[], period: number = 14): (number | null)[] {
  const rsiArray: (number | null)[] = [];
  let gains = 0;
  let losses = 0;

  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (i <= period) {
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);

      if (i === period) {
        const avgGain = gains / period;
        const avgLoss = losses / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));
        rsiArray.push(Number(rsi.toFixed(1)));
      } else {
        rsiArray.push(null);
      }
    } else {
      const prevRsi = rsiArray[rsiArray.length - 1];
      if (prevRsi !== null) {
        const currentGain = diff > 0 ? diff : 0;
        const currentLoss = diff < 0 ? Math.abs(diff) : 0;
        gains = (gains * (period - 1) + currentGain) / period;
        losses = (losses * (period - 1) + currentLoss) / period;
        const rs = losses === 0 ? 100 : gains / losses;
        const rsi = 100 - (100 / (1 + rs));
        rsiArray.push(Number(rsi.toFixed(1)));
      } else {
        rsiArray.push(null);
      }
    }
  }
  // Align length with candles
  return [null, ...rsiArray];
}

export const LiveFeedView: React.FC<LiveFeedViewProps> = ({ currentEquity, riskPerTradePct, themeMode = 'dark' }) => {
  const [selectedAsset, setSelectedAsset] = useState<MarketAsset>(MARKET_ASSETS[0]); // DERIV:R_10
  const [customSymbol, setCustomSymbol] = useState('');
  const [selectedInterval, setSelectedInterval] = useState<string>('15');
  const [chartMode, setChartMode] = useState<'native' | 'tradingview'>('native');
  const [stopLossPips, setStopLossPips] = useState<number>(25);
  const [orderToast, setOrderToast] = useState<string | null>(null);

  // Indicators toggle
  const [showEma20, setShowEma20] = useState(true);
  const [showEma50, setShowEma50] = useState(true);
  const [showEma200, setShowEma200] = useState(false);
  const [showVolume, setShowVolume] = useState(true);
  const [showRsi, setShowRsi] = useState(true);

  // Chart data state
  const [candles, setCandles] = useState<Candle[]>(() => generateCandleData(selectedAsset.price, 60, selectedInterval));
  const [hoveredCandle, setHoveredCandle] = useState<{ candle: Candle; index: number; x: number; y: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset candle history on asset or interval change
  useEffect(() => {
    setCandles(generateCandleData(selectedAsset.price, 60, selectedInterval));
  }, [selectedAsset.symbol, selectedInterval]);

  // Real-time live tick engine simulating Deriv Synthetic Volatility & Market movements
  useEffect(() => {
    const timer = window.setInterval(() => {
      setCandles((prev) => {
        if (prev.length === 0) return prev;
        const last = { ...prev[prev.length - 1] };
        // Realistic random walk tick
        const tickMove = (Math.random() - 0.49) * (selectedAsset.price * 0.0007);
        const newClose = Number((last.close + tickMove).toFixed(2));
        const newHigh = Math.max(last.high, newClose);
        const newLow = Math.min(last.low, newClose);
        const newVolume = last.volume + Math.floor(Math.random() * 8 + 1);

        const updatedLast: Candle = {
          ...last,
          close: newClose,
          high: newHigh,
          low: newLow,
          volume: newVolume,
        };

        return [...prev.slice(0, prev.length - 1), updatedLast];
      });
    }, 1200);

    return () => window.clearInterval(timer);
  }, [selectedAsset.price]);

  // Derived indicator calculations
  const ema20 = useMemo(() => calculateEMA(candles, 20), [candles]);
  const ema50 = useMemo(() => calculateEMA(candles, 50), [candles]);
  const ema200 = useMemo(() => calculateEMA(candles, 200), [candles]);
  const rsi14 = useMemo(() => calculateRSI(candles, 14), [candles]);

  // Calculate lot size based on equity, risk % and stop loss
  const dollarRisk = (currentEquity * riskPerTradePct) / 100;
  const estimatedPipValue = selectedAsset.symbol.includes('DERIV') ? 2.5 : 10;
  const calculatedLots = Math.max(0.01, Number((dollarRisk / (stopLossPips * estimatedPipValue)).toFixed(2)));

  // Canvas Drawing Routine
  const drawChart = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle high-DPI retina display
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;

    const isLight = themeMode !== 'dark';

    // Clear background
    ctx.fillStyle = isLight ? '#ffffff' : '#07090e';
    ctx.fillRect(0, 0, width, height);

    if (candles.length === 0) return;

    // Layout configuration
    const paddingRight = 65; // Y-axis labels
    const paddingBottom = showRsi ? 90 : 25; // X-axis + RSI subchart
    const chartWidth = width - paddingRight;
    const priceChartHeight = height - paddingBottom;

    // Compute min / max price for scaling
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    candles.forEach((c) => {
      if (c.low < minPrice) minPrice = c.low;
      if (c.high > maxPrice) maxPrice = c.high;
    });
    const priceRange = maxPrice - minPrice || 1;
    const paddedMin = minPrice - priceRange * 0.05;
    const paddedMax = maxPrice + priceRange * 0.05;
    const finalPriceRange = paddedMax - paddedMin;

    const getY = (price: number) => {
      return priceChartHeight - ((price - paddedMin) / finalPriceRange) * priceChartHeight;
    };

    // 1. Draw Grid Lines
    ctx.strokeStyle = isLight ? '#e2e8f0' : '#121927';
    ctx.lineWidth = 1;

    // Horizontal price grid lines
    const gridStepCount = 6;
    ctx.fillStyle = isLight ? '#000000' : '#64748b';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'left';

    for (let i = 0; i <= gridStepCount; i++) {
      const p = paddedMin + (finalPriceRange / gridStepCount) * i;
      const y = getY(p);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(chartWidth, y);
      ctx.stroke();

      // Price label on right margin
      ctx.fillText(p.toLocaleString('en-US', { minimumFractionDigits: 2 }), chartWidth + 6, y + 3);
    }

    // Candle bar geometry
    const candleWidth = Math.max(3, (chartWidth / candles.length) * 0.65);
    const candleGap = chartWidth / candles.length;

    // 2. Draw Volume Histogram (at base of price chart)
    if (showVolume) {
      const maxVolume = Math.max(...candles.map((c) => c.volume), 1);
      const volumeAreaHeight = priceChartHeight * 0.22;

      candles.forEach((c, i) => {
        const x = i * candleGap + candleGap / 2;
        const vHeight = (c.volume / maxVolume) * volumeAreaHeight;
        const isUp = c.close >= c.open;
        ctx.fillStyle = isUp ? 'rgba(16, 185, 129, 0.2)' : 'rgba(244, 63, 94, 0.2)';
        ctx.fillRect(x - candleWidth / 2, priceChartHeight - vHeight, candleWidth, vHeight);
      });
    }

    // 3. Draw Candlesticks
    candles.forEach((c, i) => {
      const x = i * candleGap + candleGap / 2;
      const openY = getY(c.open);
      const closeY = getY(c.close);
      const highY = getY(c.high);
      const lowY = getY(c.low);
      const isUp = c.close >= c.open;

      // Wick
      ctx.strokeStyle = isUp ? '#10b981' : '#f43f5e';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, highY);
      ctx.lineTo(x, lowY);
      ctx.stroke();

      // Body
      ctx.fillStyle = isUp ? '#10b981' : '#f43f5e';
      const bodyTop = Math.min(openY, closeY);
      const bodyHeight = Math.max(2, Math.abs(closeY - openY));
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
    });

    // 4. Draw EMAs
    const drawIndicatorLine = (data: (number | null)[], strokeStyle: string) => {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let hasStarted = false;

      data.forEach((val, i) => {
        if (val === null) return;
        const x = i * candleGap + candleGap / 2;
        const y = getY(val);
        if (!hasStarted) {
          ctx.moveTo(x, y);
          hasStarted = true;
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    };

    if (showEma20) drawIndicatorLine(ema20, '#06b6d4'); // Cyan
    if (showEma50) drawIndicatorLine(ema50, '#f59e0b'); // Amber
    if (showEma200) drawIndicatorLine(ema200, '#a855f7'); // Purple

    // 5. Draw Live Last-Price Marker Line
    const lastCandle = candles[candles.length - 1];
    if (lastCandle) {
      const currentY = getY(lastCandle.close);
      const isUp = lastCandle.close >= lastCandle.open;

      // Dashed horizontal price beam
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = isUp ? '#10b981' : '#f43f5e';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, currentY);
      ctx.lineTo(chartWidth, currentY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Live price tag bubble
      ctx.fillStyle = isUp ? '#059669' : '#e11d48';
      ctx.fillRect(chartWidth + 1, currentY - 9, 62, 18);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9.5px JetBrains Mono, monospace';
      ctx.fillText(lastCandle.close.toFixed(2), chartWidth + 5, currentY + 3.5);
    }

    // 6. Draw RSI Subchart
    if (showRsi) {
      const rsiTop = height - 75;
      const rsiHeight = 55;

      // Subchart background divider
      ctx.fillStyle = isLight ? '#f8fafc' : '#090d16';
      ctx.fillRect(0, rsiTop, chartWidth, rsiHeight);

      // RSI Guide levels: 70, 50, 30
      ctx.strokeStyle = isLight ? '#e2e8f0' : '#1a2438';
      ctx.lineWidth = 1;
      [70, 50, 30].forEach((lvl) => {
        const y = rsiTop + rsiHeight - (lvl / 100) * rsiHeight;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(chartWidth, y);
        ctx.stroke();

        ctx.fillStyle = isLight ? '#000000' : '#475569';
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillText(String(lvl), chartWidth + 6, y + 3);
      });

      // RSI Label
      ctx.fillStyle = isLight ? '#000000' : '#94a3b8';
      ctx.font = '9px JetBrains Mono, monospace';
      const currentRsi = rsi14[rsi14.length - 1] ?? 50;
      ctx.fillText(`RSI(14): ${currentRsi}`, 8, rsiTop + 14);

      // Plot RSI line
      ctx.strokeStyle = isLight ? '#4f46e5' : '#818cf8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let rsiStarted = false;

      rsi14.forEach((val, i) => {
        if (val === null) return;
        const x = i * candleGap + candleGap / 2;
        const y = rsiTop + rsiHeight - (val / 100) * rsiHeight;
        if (!rsiStarted) {
          ctx.moveTo(x, y);
          rsiStarted = true;
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    }

    // 7. Interactive Crosshair and Hover Line
    if (hoveredCandle) {
      const { x, y, candle } = hoveredCandle;

      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = isLight ? 'rgba(0, 0, 0, 0.4)' : 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 1;

      // Vertical line
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();

      // Horizontal line
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(chartWidth, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Timestamp at bottom
      ctx.fillStyle = isLight ? '#000000' : '#1e293b';
      ctx.fillRect(x - 30, height - 16, 60, 16);
      ctx.fillStyle = '#ffffff';
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(candle.time, x, height - 4);
      ctx.textAlign = 'left';
    }
  }, [candles, ema20, ema50, ema200, rsi14, showEma20, showEma50, showEma200, showVolume, showRsi, hoveredCandle, themeMode]);

  // Redraw when candles or indicators change
  useEffect(() => {
    drawChart();
  }, [drawChart]);

  // Handle Canvas Resize
  useEffect(() => {
    const handleResize = () => drawChart();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [drawChart]);

  // Mouse move on canvas for interactive crosshair
  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || candles.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const paddingRight = 65;
    const chartWidth = rect.width - paddingRight;
    if (x < 0 || x > chartWidth) {
      setHoveredCandle(null);
      return;
    }

    const candleGap = chartWidth / candles.length;
    const index = Math.min(candles.length - 1, Math.max(0, Math.floor(x / candleGap)));
    const candle = candles[index];

    setHoveredCandle({
      candle,
      index,
      x: index * candleGap + candleGap / 2,
      y,
    });
  };

  const handleCanvasMouseLeave = () => {
    setHoveredCandle(null);
  };

  const handleAssetSelect = (asset: MarketAsset) => {
    setSelectedAsset(asset);
    setCustomSymbol('');
  };

  const handleCustomSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customSymbol.trim()) return;
  };

  const handleExecuteOrder = (direction: 'BUY' | 'SELL') => {
    const ticketNum = Math.floor(8920000 + Math.random() * 9999);
    setOrderToast(`${direction} order #${ticketNum} (${calculatedLots} lots on ${customSymbol || selectedAsset.symbol}) dispatched to MT5!`);
    setTimeout(() => setOrderToast(null), 4000);
  };

  const lastCandle = candles[candles.length - 1];
  const activeHover = hoveredCandle ? hoveredCandle.candle : lastCandle;
  const isUp = activeHover ? activeHover.close >= activeHover.open : true;
  const candleChange = activeHover ? Number((((activeHover.close - activeHover.open) / activeHover.open) * 100).toFixed(2)) : 0;

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Toast Notification */}
      {orderToast && (
        <div className="fixed top-20 right-8 z-50 p-4 rounded-xl bg-blue-600 text-white shadow-xl flex items-center gap-2.5 text-xs font-semibold animate-in fade-in slide-in-from-top-2 border border-blue-400">
          <CheckCircle2 className="w-4 h-4 text-emerald-300" />
          <span>{orderToast}</span>
        </div>
      )}

      {/* View Header */}
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-300 dark:border-[#1a2030]"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-black dark:text-white flex items-center gap-2.5">
            Live Market Feeds & Terminal
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
              Broker Low-Latency Stream
            </span>
          </h1>
          <p className="text-sm text-black dark:text-slate-400 mt-1">
            Real-time market streaming, institutional EMAs, RSI oscillator, and automated risk sizing.
          </p>
        </div>

        {/* Mode Selector & Timeframe Bar */}
        <div className="flex items-center gap-3">
          {/* Chart Mode Toggle */}
          <div className="flex items-center bg-white dark:bg-[#0f1118] p-1 rounded-xl border border-slate-300 dark:border-[#1a2030] shadow-xs">
            <button
              onClick={() => setChartMode('native')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                chartMode === 'native'
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'text-black dark:text-slate-400 hover:text-black dark:hover:text-white'
              }`}
            >
              Native Engine
            </button>
            <button
              onClick={() => setChartMode('tradingview')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                chartMode === 'tradingview'
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'text-black dark:text-slate-400 hover:text-black dark:hover:text-white'
              }`}
            >
              TradingView Frame
            </button>
          </div>

          {/* Timeframe Bar */}
          <div className="flex items-center bg-white dark:bg-[#0f1118] p-1 rounded-xl border border-slate-300 dark:border-[#1a2030] shadow-xs">
            {[
              { label: '1m', val: '1' },
              { label: '5m', val: '5' },
              { label: '15m', val: '15' },
              { label: '1h', val: '60' },
              { label: '4h', val: '240' },
              { label: '1D', val: 'D' },
            ].map((tf) => (
              <button
                key={tf.val}
                onClick={() => setSelectedInterval(tf.val)}
                className={`px-2.5 py-1 text-xs font-mono font-semibold rounded-lg transition-all cursor-pointer ${
                  selectedInterval === tf.val
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-black dark:text-slate-400 hover:text-black dark:hover:text-white'
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>
      </motion.div>

      {/* Asset Quick Switcher Pills */}
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.35 }}
        className="flex items-center gap-3 overflow-x-auto pb-1"
      >
        {MARKET_ASSETS.map((asset) => {
          const isSelected = selectedAsset.symbol === asset.symbol && !customSymbol;
          const isAssetUp = asset.change24h >= 0;

          return (
            <button
              key={asset.symbol}
              onClick={() => handleAssetSelect(asset)}
              className={`flex items-center gap-3 px-3.5 py-2 rounded-xl border transition-all shrink-0 text-left cursor-pointer ${
                isSelected
                  ? 'bg-blue-600/10 border-blue-500 shadow-xs text-blue-600 dark:text-blue-400'
                  : 'bg-white dark:bg-[#0f1118] border-slate-300 dark:border-[#1a2030] hover:border-slate-400 dark:hover:border-slate-700 shadow-xs'
              }`}
            >
              <div className="flex flex-col">
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs font-bold font-mono ${isSelected ? 'text-blue-600 dark:text-blue-400' : 'text-black dark:text-white'}`}>
                    {asset.symbol}
                  </span>
                  {asset.symbol.includes('DERIV') && (
                    <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-bold">
                      SYNTHETIC
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[11px] mt-0.5">
                  <span className="font-mono text-black dark:text-slate-300">
                    {asset.price.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                  <span className={`flex items-center font-mono font-semibold ${isAssetUp ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                    {isAssetUp ? '+' : ''}{asset.change24h}%
                  </span>
                </div>
              </div>
            </button>
          );
        })}

        {/* Custom Symbol Search */}
        <form onSubmit={handleCustomSearch} className="flex items-center shrink-0">
          <div className="relative">
            <input
              type="text"
              placeholder="Other symbol (e.g. DERIV:R_75)..."
              value={customSymbol}
              onChange={(e) => setCustomSymbol(e.target.value.toUpperCase())}
              className="px-3 py-2 pl-9 bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] rounded-xl text-xs font-mono text-black dark:text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 w-56 shadow-xs"
            />
            <Search className="w-3.5 h-3.5 text-black dark:text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          </div>
        </form>
      </motion.div>

      {/* Main Split: Canvas Chart / Safe TradingView Frame + Sizing Terminal */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4 }}
        className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-[500px]"
      >
        {/* Chart Viewport */}
        <div className="lg:col-span-8 xl:col-span-9 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs overflow-hidden flex flex-col relative min-h-[420px]">
          {/* Chart Info Header HUD & Indicator Controls */}
          <div className="px-4 py-3 bg-white dark:bg-[#0b101a] border-b border-slate-300 dark:border-[#1a2030] flex flex-wrap items-center justify-between gap-3 text-xs shrink-0 select-none">
            {/* Symbol & Live OHLC HUD */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="font-bold text-black dark:text-white font-mono">
                  {customSymbol || selectedAsset.symbol}
                </span>
                <span className="text-[10px] text-blue-600 dark:text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full border border-blue-500/20 font-mono">
                  {chartMode === 'native' ? 'LOW-LATENCY STREAM' : 'TRADINGVIEW BRIDGE'}
                </span>
              </div>

              {activeHover && chartMode === 'native' && (
                <div className="hidden sm:flex items-center gap-3 text-[11px] font-mono">
                  <span className="text-black dark:text-slate-500">O: <strong className="text-black dark:text-slate-200">{activeHover.open.toFixed(2)}</strong></span>
                  <span className="text-black dark:text-slate-500">H: <strong className="text-black dark:text-slate-200">{activeHover.high.toFixed(2)}</strong></span>
                  <span className="text-black dark:text-slate-500">L: <strong className="text-black dark:text-slate-200">{activeHover.low.toFixed(2)}</strong></span>
                  <span className="text-black dark:text-slate-500">C: <strong className={isUp ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>{activeHover.close.toFixed(2)}</strong></span>
                  <span className={isUp ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>({candleChange > 0 ? '+' : ''}{candleChange}%)</span>
                </div>
              )}
            </div>

            {/* Indicator Toggles */}
            {chartMode === 'native' && (
              <div className="flex items-center gap-1.5 text-[10px] font-mono">
                <button
                  onClick={() => setShowEma20(!showEma20)}
                  className={`px-2 py-0.5 rounded-md border transition-colors cursor-pointer ${
                    showEma20
                      ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30 font-bold'
                      : 'text-black dark:text-slate-500 border-transparent hover:text-blue-600 dark:hover:text-slate-300'
                  }`}
                >
                  EMA 20
                </button>
                <button
                  onClick={() => setShowEma50(!showEma50)}
                  className={`px-2 py-0.5 rounded-md border transition-colors cursor-pointer ${
                    showEma50
                      ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 font-bold'
                      : 'text-black dark:text-slate-500 border-transparent hover:text-amber-600 dark:hover:text-slate-300'
                  }`}
                >
                  EMA 50
                </button>
                <button
                  onClick={() => setShowEma200(!showEma200)}
                  className={`px-2 py-0.5 rounded-md border transition-colors cursor-pointer ${
                    showEma200
                      ? 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30 font-bold'
                      : 'text-black dark:text-slate-500 border-transparent hover:text-purple-600 dark:hover:text-slate-300'
                  }`}
                >
                  EMA 200
                </button>
                <button
                  onClick={() => setShowVolume(!showVolume)}
                  className={`px-2 py-0.5 rounded-md border transition-colors cursor-pointer ${
                    showVolume
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 font-bold'
                      : 'text-black dark:text-slate-500 border-transparent hover:text-emerald-700 dark:hover:text-slate-300'
                  }`}
                >
                  VOL
                </button>
                <button
                  onClick={() => setShowRsi(!showRsi)}
                  className={`px-2 py-0.5 rounded-md border transition-colors cursor-pointer ${
                    showRsi
                      ? 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/30 font-bold'
                      : 'text-black dark:text-slate-500 border-transparent hover:text-indigo-700 dark:hover:text-slate-300'
                  }`}
                >
                  RSI
                </button>
              </div>
            )}
          </div>

          {/* Chart Display Area */}
          <div ref={containerRef} className="flex-1 w-full h-full relative bg-white dark:bg-[#07090e]">
            {chartMode === 'native' ? (
              <canvas
                ref={canvasRef}
                onMouseMove={handleCanvasMouseMove}
                onMouseLeave={handleCanvasMouseLeave}
                className="w-full h-full cursor-crosshair block"
              />
            ) : (
              /* Isolated sandboxed iframe for TradingView - safe from cross-origin script error leaks */
              <iframe
                src={`https://s.tradingview.com/widgetembed/?frameElementId=tradingview_widget&symbol=${encodeURIComponent(
                  customSymbol || selectedAsset.tvSymbol
                )}&interval=${selectedInterval}&theme=${themeMode === 'dark' ? 'dark' : 'light'}&style=1&timezone=Etc%2FUTC&studies=%5B%22STD%3BEMA%22%2C%22%22STD%3BRSI%22%5D&locale=en`}
                className="w-full h-full border-0"
                title="TradingView Embedded Widget"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            )}
          </div>
        </div>

        {/* Side Risk & Sizing Calculator */}
        <div className="lg:col-span-4 xl:col-span-3 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-6 flex flex-col justify-between overflow-y-auto space-y-6">
          <div>
            <div className="flex items-center gap-2.5 pb-4 border-b border-slate-300 dark:border-[#1a2030]">
              <div className="p-2 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                <Calculator className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-black dark:text-white tracking-wide">Position Size Engine</h3>
                <p className="text-[11px] text-black dark:text-slate-400">Auto-calibrated to account equity</p>
              </div>
            </div>

            <div className="mt-4 space-y-4 text-xs">
              {/* Account Equity Display */}
              <div className="p-3 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] flex items-center justify-between shadow-xs">
                <span className="text-black dark:text-slate-400 font-medium">Account Equity:</span>
                <span className="font-mono font-bold text-black dark:text-white">
                  ${currentEquity.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </span>
              </div>

              {/* Dollar Risk per Trade */}
              <div className="p-3 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] flex items-center justify-between shadow-xs">
                <span className="text-black dark:text-slate-400 font-medium">Risk ({riskPerTradePct}%):</span>
                <span className="font-mono font-bold text-blue-600 dark:text-blue-400">
                  ${dollarRisk.toFixed(2)}
                </span>
              </div>

              {/* Stop Loss Distance */}
              <div className="space-y-1.5">
                <label className="text-black dark:text-slate-300 font-semibold block text-xs">
                  Stop Loss Distance (Points / Pips):
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="5"
                    max="500"
                    value={stopLossPips}
                    onChange={(e) => setStopLossPips(Math.max(1, parseFloat(e.target.value) || 1))}
                    className="w-full px-3 py-2 bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] rounded-xl font-mono text-black dark:text-white text-xs focus:border-blue-500 focus:outline-none shadow-xs"
                  />
                  <span className="text-[11px] text-black dark:text-slate-400 shrink-0 font-mono">pts</span>
                </div>
              </div>

              {/* Recommended Lot Size Result Card */}
              <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/30 text-center space-y-1 shadow-xs">
                <div className="text-[10px] uppercase font-bold text-blue-600 dark:text-blue-400 tracking-wider">
                  Recommended Volume
                </div>
                <div className="text-3xl font-bold font-mono text-black dark:text-white tracking-tight">
                  {calculatedLots} <span className="text-sm font-normal text-black dark:text-slate-400">Lots</span>
                </div>
                <div className="text-[11px] text-black dark:text-slate-400">
                  Max Risk: <strong className="text-rose-600 dark:text-rose-400 font-mono">-${dollarRisk.toFixed(2)}</strong> ({riskPerTradePct}%)
                </div>
              </div>

              {/* Quick Execution Buttons Simulation */}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => handleExecuteOrder('BUY')}
                  className="py-3 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-xs transition-all flex items-center justify-center gap-1.5 cursor-pointer active:scale-95"
                >
                  <TrendingUp className="w-3.5 h-3.5" />
                  <span>BUY / LONG</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleExecuteOrder('SELL')}
                  className="py-3 px-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs shadow-xs transition-all flex items-center justify-center gap-1.5 cursor-pointer active:scale-95"
                >
                  <TrendingDown className="w-3.5 h-3.5" />
                  <span>SELL / SHORT</span>
                </button>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-300 dark:border-[#1a2030] text-[11px] text-black dark:text-slate-400 space-y-1.5">
            <div className="flex justify-between">
              <span>Feed Provider:</span>
              <span className="text-black dark:text-slate-300 font-mono">WebSocket Bridge</span>
            </div>
            <div className="flex justify-between">
              <span>Execution Routing:</span>
              <span className="text-emerald-700 dark:text-emerald-400 font-mono">STP/DMA Bridge</span>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

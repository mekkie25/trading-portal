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
  Sliders,
  CheckCircle2,
  Maximize2,
  Minimize2,
  Crosshair,
  Target,
  Minus,
  Square,
  Trash2,
  Settings2,
  X,
  Clock,
  Eye,
  ArrowUp,
  ArrowDown
} from 'lucide-react';
import { MARKET_ASSETS } from '../../data/mockTradingData';
import { MarketAsset, ThemeMode, TradeRecord } from '../../types';

interface Candle {
  time: string;
  hour: number;
  minute: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface DrawingItem {
  id: string;
  type: 'TRENDLINE' | 'RAY' | 'RECTANGLE';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}

interface LiveFeedViewProps {
  currentEquity: number;
  riskPerTradePct: number;
  themeMode?: ThemeMode;
  activeTrades?: TradeRecord[];
}

function generateCandleData(basePrice: number, count: number = 70, intervalStr: string = '5'): Candle[] {
  const candles: Candle[] = [];
  let current = basePrice * 0.985;
  const now = Date.now();
  const stepMinutes = intervalStr === '1' ? 1 : intervalStr === '5' ? 5 : intervalStr === '15' ? 15 : intervalStr === '30' ? 30 : intervalStr === '60' ? 60 : intervalStr === '240' ? 240 : 1440;
  const stepMs = stepMinutes * 60 * 1000;

  for (let i = count; i >= 0; i--) {
    const d = new Date(now - i * stepMs);
    const volatility = basePrice * 0.0032;
    const change = (Math.random() - 0.485) * volatility;
    const open = current;
    const close = open + change;
    const high = Math.max(open, close) + Math.random() * (volatility * 0.7);
    const low = Math.min(open, close) - Math.random() * (volatility * 0.7);
    const volume = Math.floor(180 + Math.random() * 820);

    candles.push({
      time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
      hour: d.getHours(),
      minute: d.getMinutes(),
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

function calculateRSI(candles: Candle[], period: number = 14): (number | null)[] {
  const rsiArray: (number | null)[] = [];
  let gains = 0, losses = 0;

  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (i <= period) {
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);

      if (i === period) {
        const avgGain = gains / period;
        const avgLoss = losses / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsiArray.push(Number((100 - (100 / (1 + rs))).toFixed(1)));
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
        rsiArray.push(Number((100 - (100 / (1 + rs))).toFixed(1)));
      } else {
        rsiArray.push(null);
      }
    }
  }
  return [null, ...rsiArray];
}

export const LiveFeedView: React.FC<LiveFeedViewProps> = ({ 
  currentEquity, 
  riskPerTradePct, 
  themeMode = 'dark',
  activeTrades = []
}) => {
  const [selectedAsset, setSelectedAsset] = useState<MarketAsset>(MARKET_ASSETS[1] || MARKET_ASSETS[0]); // Default US30
  const [customSymbol, setCustomSymbol] = useState('');
  const [selectedInterval, setSelectedInterval] = useState<string>('5');
  const [stopLossPips, setStopLossPips] = useState<number>(35);
  const [orderToast, setOrderToast] = useState<string | null>(null);

  // Full Screen State
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const chartWrapperRef = useRef<HTMLDivElement>(null);

  // Indicators toggle
  const [showEma20, setShowEma20] = useState(true);
  const [showEma50, setShowEma50] = useState(true);
  const [showEma200, setShowEma200] = useState(true);
  const [showVolume, setShowVolume] = useState(true);
  const [showRsi, setShowRsi] = useState(true);
  const [showVwap, setShowVwap] = useState(true);
  const [showPivots, setShowPivots] = useState(true);
  const [showAsiaBox, setShowAsiaBox] = useState(true);

  // Customization Settings
  const [asiaOpacity, setAsiaOpacity] = useState<number>(0.18);
  const [asiaColor, setAsiaColor] = useState<string>('#3b82f6');
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);

  // Active Drawing Tool: 'POINTER' | 'TRENDLINE' | 'RAY' | 'RECTANGLE' | 'POSITION_BOX'
  const [activeTool, setActiveTool] = useState<'POINTER' | 'TRENDLINE' | 'RAY' | 'RECTANGLE' | 'POSITION_BOX'>('POSITION_BOX');
  const [drawings, setDrawings] = useState<DrawingItem[]>([]);
  const [currentDraw, setCurrentDraw] = useState<{ startX: number; startY: number } | null>(null);

  // Red & Green Risk-to-Reward Position Box Tool State
  const [showPositionBox, setShowPositionBox] = useState(true);
  const [positionType, setPositionType] = useState<'LONG' | 'SHORT'>('LONG');
  const [targetMultiplier, setTargetMultiplier] = useState<number>(2.0); // 1:2 R:R

  // Chart data state
  const [candles, setCandles] = useState<Candle[]>(() => generateCandleData(selectedAsset.price, 70, selectedInterval));
  const [hoveredCandle, setHoveredCandle] = useState<{ candle: Candle; index: number; x: number; y: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCandles(generateCandleData(selectedAsset.price, 70, selectedInterval));
  }, [selectedAsset.symbol, selectedInterval]);

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

  // Tick engine
  useEffect(() => {
    const timer = window.setInterval(() => {
      setCandles((prev) => {
        if (prev.length === 0) return prev;
        const last = { ...prev[prev.length - 1] };
        const tickMove = (Math.random() - 0.495) * (selectedAsset.price * 0.0006);
        const newClose = Number((last.close + tickMove).toFixed(2));
        const newHigh = Math.max(last.high, newClose);
        const newLow = Math.min(last.low, newClose);
        const newVolume = last.volume + Math.floor(Math.random() * 6 + 1);

        const updatedLast: Candle = {
          ...last,
          close: newClose,
          high: newHigh,
          low: newLow,
          volume: newVolume,
        };
        return [...prev.slice(0, prev.length - 1), updatedLast];
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [selectedAsset.price]);

  const ema20 = useMemo(() => calculateEMA(candles, 20), [candles]);
  const ema50 = useMemo(() => calculateEMA(candles, 50), [candles]);
  const ema200 = useMemo(() => calculateEMA(candles, 200), [candles]);
  const rsi14 = useMemo(() => calculateRSI(candles, 14), [candles]);

  const vwapLine = useMemo(() => {
    let cumVol = 0, cumTypicalVol = 0;
    return candles.map((c) => {
      const typical = (c.high + c.low + c.close) / 3;
      cumVol += c.volume;
      cumTypicalVol += typical * c.volume;
      return cumVol > 0 ? Number((cumTypicalVol / cumVol).toFixed(2)) : c.close;
    });
  }, [candles]);

  // Daily Pivot Points (Traditional)
  const pivotLevels = useMemo(() => {
    if (candles.length < 20) return null;
    const subset = candles.slice(-40);
    const high = Math.max(...subset.map(c => c.high));
    const low = Math.min(...subset.map(c => c.low));
    const close = subset[subset.length - 1].close;

    const p = (high + low + close) / 3.0;
    const r1 = (2 * p) - low;
    const s1 = (2 * p) - high;
    const r2 = p + (high - low);
    const s2 = p - (high - low);
    const r3 = high + 2 * (p - low);
    const s3 = low - 2 * (high - p);

    return { p, r1, s1, r2, s2, r3, s3 };
  }, [candles]);

  // Position sizing
  const dollarRisk = (currentEquity * riskPerTradePct) / 100;
  const estimatedPipValue = selectedAsset.symbol.includes('DERIV') ? 2.5 : 1.0;
  const calculatedLots = Math.max(0.01, Number((dollarRisk / (stopLossPips * estimatedPipValue)).toFixed(2)));

  // Master Canvas Drawing Routine
  const drawChart = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const isLight = themeMode !== 'dark';

    ctx.fillStyle = isLight ? '#ffffff' : '#07090e';
    ctx.fillRect(0, 0, width, height);

    if (candles.length === 0) return;

    const paddingRight = 72;
    const paddingBottom = showRsi ? 85 : 25;
    const chartWidth = width - paddingRight;
    const priceChartHeight = height - paddingBottom;

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    candles.forEach((c) => {
      if (c.low < minPrice) minPrice = c.low;
      if (c.high > maxPrice) maxPrice = c.high;
    });

    const priceRange = maxPrice - minPrice || 1;
    const paddedMin = minPrice - priceRange * 0.08;
    const paddedMax = maxPrice + priceRange * 0.08;
    const finalPriceRange = paddedMax - paddedMin;

    const getY = (price: number) => {
      return priceChartHeight - ((price - paddedMin) / finalPriceRange) * priceChartHeight;
    };

    // 1. Grid
    ctx.strokeStyle = isLight ? '#e2e8f0' : '#121927';
    ctx.lineWidth = 1;
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
      ctx.fillText(p.toLocaleString('en-US', { minimumFractionDigits: 2 }), chartWidth + 6, y + 3);
    }

    const candleWidth = Math.max(3, (chartWidth / candles.length) * 0.65);
    const candleGap = chartWidth / candles.length;

    // 2. ASIA SESSION SHADED BOX (01:00 - 06:00 SAST) WITH 50% EQUILIBRIUM (EQ)
    if (showAsiaBox) {
      let asiaStartIndex = -1;
      let asiaEndIndex = -1;
      let asiaHigh = -Infinity;
      let asiaLow = Infinity;

      candles.forEach((c, idx) => {
        // Asian session roughly maps between hours 1 and 6
        const isAsia = c.hour >= 1 && c.hour < 6;
        if (isAsia) {
          if (asiaStartIndex === -1) asiaStartIndex = idx;
          asiaEndIndex = idx;
          if (c.high > asiaHigh) asiaHigh = c.high;
          if (c.low < asiaLow) asiaLow = c.low;
        }
      });

      if (asiaStartIndex !== -1 && asiaEndIndex !== -1 && asiaHigh !== -Infinity) {
        const boxX = asiaStartIndex * candleGap;
        const boxW = Math.max(candleGap, (asiaEndIndex - asiaStartIndex + 1) * candleGap);
        const boxTopY = getY(asiaHigh);
        const boxBottomY = getY(asiaLow);
        const boxH = Math.abs(boxBottomY - boxTopY);

        // Shaded Box
        ctx.fillStyle = `rgba(59, 130, 246, ${asiaOpacity})`;
        ctx.fillRect(boxX, boxTopY, boxW, boxH);
        ctx.strokeStyle = asiaColor;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(boxX, boxTopY, boxW, boxH);

        // 50% Daily Equilibrium (EQ) Line
        const eqPrice = (asiaHigh + asiaLow) / 2;
        const eqY = getY(eqPrice);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#f59e0b';
        ctx.beginPath();
        ctx.moveTo(boxX, eqY);
        ctx.lineTo(chartWidth, eqY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#f59e0b';
        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.fillText(`ASIA EQ: ${eqPrice.toFixed(2)}`, boxX + 4, eqY - 4);

        ctx.fillStyle = isLight ? '#1e40af' : '#93c5fd';
        ctx.fillText(`ASIA RANGE (01:00 - 06:00 SAST)`, boxX + 4, boxTopY - 6);
      }
    }

    // 3. DAILY FLOOR PIVOT POINTS (P, R1, S1, R2, S2, R3, S3)
    if (showPivots && pivotLevels) {
      const drawPivotLine = (price: number, label: string, color: string) => {
        const y = getY(price);
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(chartWidth, y);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = color;
        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.fillText(`${label}: ${price.toFixed(1)}`, chartWidth + 6, y - 2);
      };

      drawPivotLine(pivotLevels.p, 'P', '#f59e0b');
      drawPivotLine(pivotLevels.r1, 'R1', '#3b82f6');
      drawPivotLine(pivotLevels.s1, 'S1', '#3b82f6');
      drawPivotLine(pivotLevels.r2, 'R2', '#10b981');
      drawPivotLine(pivotLevels.s2, 'S2', '#ef4444');
    }

    // 4. TRADINGVIEW RED/GREEN RISK-TO-REWARD POSITION BOX
    if (showPositionBox && candles.length > 25) {
      const lastPrice = candles[candles.length - 1].close;
      const slDist = stopLossPips;
      const tpDist = stopLossPips * targetMultiplier;

      const entryPrice = lastPrice;
      const slPrice = positionType === 'LONG' ? entryPrice - slDist : entryPrice + slDist;
      const tpPrice = positionType === 'LONG' ? entryPrice + tpDist : entryPrice - tpDist;

      const entryY = getY(entryPrice);
      const slY = getY(slPrice);
      const tpY = getY(tpPrice);

      const boxStartX = Math.max(0, chartWidth - (candleGap * 30));
      const boxWidth = chartWidth - boxStartX;

      // Green Box (Reward Zone)
      const greenTop = Math.min(entryY, tpY);
      const greenHeight = Math.abs(tpY - entryY);
      ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
      ctx.fillRect(boxStartX, greenTop, boxWidth, greenHeight);
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(boxStartX, greenTop, boxWidth, greenHeight);

      // Red Box (Risk Zone)
      const redTop = Math.min(entryY, slY);
      const redHeight = Math.abs(slY - entryY);
      ctx.fillStyle = 'rgba(244, 63, 94, 0.22)';
      ctx.fillRect(boxStartX, redTop, boxWidth, redHeight);
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(boxStartX, redTop, boxWidth, redHeight);

      // Entry Ray
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(boxStartX, entryY);
      ctx.lineTo(chartWidth, entryY);
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px JetBrains Mono, monospace';
      ctx.fillText(`Target: ${tpPrice.toFixed(2)} (+${tpDist.toFixed(1)} pts)`, boxStartX + 8, greenTop + (greenHeight / 2) + 3);
      ctx.fillText(`Stop Loss: ${slPrice.toFixed(2)} (-${slDist.toFixed(1)} pts)`, boxStartX + 8, redTop + (redHeight / 2) + 3);
      ctx.fillText(`R:R 1:${targetMultiplier.toFixed(1)} | Risk: $${dollarRisk.toFixed(2)}`, boxStartX + 8, entryY - 6);
    }

    // 5. Volume Histogram
    if (showVolume) {
      const maxVolume = Math.max(...candles.map((c) => c.volume), 1);
      const volumeAreaHeight = priceChartHeight * 0.18;

      candles.forEach((c, i) => {
        const x = i * candleGap + candleGap / 2;
        const vHeight = (c.volume / maxVolume) * volumeAreaHeight;
        const isCandleUp = c.close >= c.open;
        ctx.fillStyle = isCandleUp ? 'rgba(16, 185, 129, 0.18)' : 'rgba(244, 63, 94, 0.18)';
        ctx.fillRect(x - candleWidth / 2, priceChartHeight - vHeight, candleWidth, vHeight);
      });
    }

    // 6. Candlesticks
    candles.forEach((c, i) => {
      const x = i * candleGap + candleGap / 2;
      const openY = getY(c.open);
      const closeY = getY(c.close);
      const highY = getY(c.high);
      const lowY = getY(c.low);
      const isCandleUp = c.close >= c.open;

      // Wick
      ctx.strokeStyle = isCandleUp ? '#10b981' : '#f43f5e';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, highY);
      ctx.lineTo(x, lowY);
      ctx.stroke();

      // Body
      ctx.fillStyle = isCandleUp ? '#10b981' : '#f43f5e';
      const bodyTop = Math.min(openY, closeY);
      const bodyHeight = Math.max(2, Math.abs(closeY - openY));
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);

      // 7. GREEN BUY & RED SELL ARROWS AT THE CANDLES (TRADE MARKERS)
      // Display visual arrows when bot executed on this candle
      if (i === candles.length - 12) {
        // Example Green Buy Arrow below candle pointing UP
        ctx.fillStyle = '#10b981';
        ctx.beginPath();
        ctx.moveTo(x, lowY + 16);
        ctx.lineTo(x - 6, lowY + 28);
        ctx.lineTo(x + 6, lowY + 28);
        ctx.closePath();
        ctx.fill();

        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.fillText(`BUY US30`, x - 20, lowY + 40);
        ctx.fillText(`+130 pts`, x - 18, lowY + 52);
      }

      if (i === candles.length - 28) {
        // Example Red Sell Arrow above candle pointing DOWN
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.moveTo(x, highY - 16);
        ctx.lineTo(x - 6, highY - 28);
        ctx.lineTo(x + 6, highY - 28);
        ctx.closePath();
        ctx.fill();

        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.fillText(`SELL US30`, x - 22, highY - 32);
        ctx.fillText(`+85 pts`, x - 16, highY - 42);
      }
    });

    // 8. Indicators Lines
    const drawIndicatorLine = (data: (number | null)[], strokeStyle: string, dash: number[] = []) => {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(dash);
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
      ctx.setLineDash([]);
    };

    if (showEma20) drawIndicatorLine(ema20, '#06b6d4');
    if (showEma50) drawIndicatorLine(ema50, '#f59e0b');
    if (showEma200) drawIndicatorLine(ema200, '#a855f7');
    if (showVwap) drawIndicatorLine(vwapLine, '#3b82f6', [4, 4]);

    // 9. User Interactive Custom Drawings
    drawings.forEach(d => {
      ctx.strokeStyle = d.color;
      ctx.lineWidth = 2;
      if (d.type === 'TRENDLINE' || d.type === 'RAY') {
        ctx.beginPath();
        ctx.moveTo(d.x1, d.y1);
        ctx.lineTo(d.x2, d.y2);
        ctx.stroke();
      } else if (d.type === 'RECTANGLE') {
        ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
        ctx.fillRect(Math.min(d.x1, d.x2), Math.min(d.y1, d.y2), Math.abs(d.x2 - d.x1), Math.abs(d.y2 - d.y1));
        ctx.strokeRect(Math.min(d.x1, d.x2), Math.min(d.y1, d.y2), Math.abs(d.x2 - d.x1), Math.abs(d.y2 - d.y1));
      }
    });

    // 10. Live Price Marker Line
    const lastCandle = candles[candles.length - 1];
    if (lastCandle) {
      const currentY = getY(lastCandle.close);
      const isCandleUp = lastCandle.close >= lastCandle.open;

      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = isCandleUp ? '#10b981' : '#f43f5e';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, currentY);
      ctx.lineTo(chartWidth, currentY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = isCandleUp ? '#059669' : '#e11d48';
      ctx.fillRect(chartWidth + 1, currentY - 9, 68, 18);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9.5px JetBrains Mono, monospace';
      ctx.fillText(lastCandle.close.toFixed(2), chartWidth + 5, currentY + 3.5);
    }

    // 11. RSI Subchart
    if (showRsi) {
      const rsiTop = height - 72;
      const rsiHeight = 52;

      ctx.fillStyle = isLight ? '#f8fafc' : '#090d16';
      ctx.fillRect(0, rsiTop, chartWidth, rsiHeight);

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

      ctx.fillStyle = isLight ? '#000000' : '#94a3b8';
      ctx.font = '9px JetBrains Mono, monospace';
      const currentRsi = rsi14[rsi14.length - 1] ?? 50;
      ctx.fillText(`RSI(14): ${currentRsi}`, 8, rsiTop + 13);

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

    // 12. Crosshair
    if (hoveredCandle) {
      const { x, y, candle } = hoveredCandle;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = isLight ? 'rgba(0, 0, 0, 0.4)' : 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 1;

      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(chartWidth, y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = isLight ? '#000000' : '#1e293b';
      ctx.fillRect(x - 30, height - 16, 60, 16);
      ctx.fillStyle = '#ffffff';
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(candle.time, x, height - 4);
      ctx.textAlign = 'left';
    }
  }, [candles, ema20, ema50, ema200, vwapLine, rsi14, pivotLevels, showEma20, showEma50, showEma200, showVwap, showPivots, showAsiaBox, asiaOpacity, asiaColor, showVolume, showRsi, showPositionBox, positionType, targetMultiplier, stopLossPips, drawings, hoveredCandle, themeMode]);

  useEffect(() => {
    drawChart();
  }, [drawChart]);

  useEffect(() => {
    const handleResize = () => drawChart();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [drawChart]);

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || candles.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const paddingRight = 70;
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

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (activeTool === 'POINTER') return;

    if (!currentDraw) {
      setCurrentDraw({ startX: x, startY: y });
    } else {
      // Finish Drawing
      const newD: DrawingItem = {
        id: `draw-${Date.now()}`,
        type: activeTool === 'TRENDLINE' ? 'TRENDLINE' : activeTool === 'RAY' ? 'RAY' : 'RECTANGLE',
        x1: currentDraw.startX,
        y1: currentDraw.startY,
        x2: x,
        y2: y,
        color: '#3b82f6'
      };
      setDrawings([...drawings, newD]);
      setCurrentDraw(null);
      setActiveTool('POINTER');
    }
  };

  const lastCandle = candles[candles.length - 1];
  const activeHover = hoveredCandle ? hoveredCandle.candle : lastCandle;
  const isUp = activeHover ? activeHover.close >= activeHover.open : true;
  const candleChange = activeHover ? Number((((activeHover.close - activeHover.open) / activeHover.open) * 100).toFixed(2)) : 0;

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
              Live Charting Terminal & Strategy Visualizer
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
                TradingView Suite
              </span>
            </h1>
            <p className="text-sm text-black dark:text-slate-400 mt-1">
              Asia Range Shaded Box, Daily Floor Pivots, Buy/Sell Candle Arrows, and Full Drawing Suite with 0 Limits.
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

      {/* Main Chart with Left Drawing Toolbar */}
      <div 
        ref={chartWrapperRef} 
        className={`rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs overflow-hidden flex flex-col relative ${
          isFullscreen ? 'w-screen h-screen !rounded-none !border-none' : 'min-h-[560px]'
        }`}
      >
        {/* Top Control Bar */}
        <div className="px-4 py-3 bg-white dark:bg-[#0b101a] border-b border-slate-300 dark:border-[#1a2030] flex flex-wrap items-center justify-between gap-3 text-xs shrink-0 select-none">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="font-bold text-black dark:text-white font-mono text-sm">
                {customSymbol || selectedAsset.symbol}
              </span>
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20 font-mono">
                LIVE DERIV
              </span>
            </div>

            {/* Timeframe Selectors */}
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

            {/* OHLC HUD */}
            {activeHover && (
              <div className="hidden xl:flex items-center gap-2.5 text-[11px] font-mono">
                <span className="text-slate-500">O: <strong className="text-black dark:text-slate-200">{activeHover.open.toFixed(2)}</strong></span>
                <span className="text-slate-500">H: <strong className="text-black dark:text-slate-200">{activeHover.high.toFixed(2)}</strong></span>
                <span className="text-slate-500">L: <strong className="text-black dark:text-slate-200">{activeHover.low.toFixed(2)}</strong></span>
                <span className="text-slate-500">C: <strong className={isUp ? 'text-emerald-600' : 'text-rose-600'}>{activeHover.close.toFixed(2)}</strong></span>
                <span className={isUp ? 'text-emerald-600 font-bold' : 'text-rose-600 font-bold'}>({candleChange > 0 ? '+' : ''}{candleChange}%)</span>
              </div>
            )}
          </div>

          {/* Quick Indicator Toggles */}
          <div className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono">
            <button onClick={() => setShowAsiaBox(!showAsiaBox)} className={`px-2 py-0.5 rounded border ${showAsiaBox ? 'bg-blue-500/15 text-blue-600 border-blue-500/30 font-bold' : 'text-slate-500 border-transparent'}`}>🌙 ASIA BOX</button>
            <button onClick={() => setShowPivots(!showPivots)} className={`px-2 py-0.5 rounded border ${showPivots ? 'bg-amber-500/15 text-amber-500 border-amber-500/30 font-bold' : 'text-slate-500 border-transparent'}`}>PIVOTS</button>
            <button onClick={() => setShowVwap(!showVwap)} className={`px-2 py-0.5 rounded border ${showVwap ? 'bg-blue-500/15 text-blue-600 border-blue-500/30 font-bold' : 'text-slate-500 border-transparent'}`}>VWAP</button>
            <button onClick={() => setShowEma200(!showEma200)} className={`px-2 py-0.5 rounded border ${showEma200 ? 'bg-purple-500/15 text-purple-500 border-purple-500/30 font-bold' : 'text-slate-500 border-transparent'}`}>200 EMA</button>

            {/* Gear Settings Modal Toggle */}
            <button
              onClick={() => setShowSettingsModal(true)}
              className="p-1.5 rounded-lg text-slate-500 hover:text-black dark:hover:text-white cursor-pointer"
              title="Customize Indicators & Opacity"
            >
              <Settings2 className="w-4 h-4 text-blue-500" />
            </button>

            {/* Fullscreen Button */}
            <button
              onClick={toggleFullscreen}
              className="p-1.5 rounded-lg text-slate-500 hover:text-black dark:hover:text-white cursor-pointer"
              title={isFullscreen ? 'Exit Full Screen' : 'Enter Full Screen'}
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4 text-amber-400" /> : <Maximize2 className="w-4 h-4 text-blue-500" />}
            </button>
          </div>
        </div>

        {/* Chart Body: Left TradingView Drawing Toolbar + Canvas Viewport */}
        <div className="flex-1 w-full flex relative min-h-[460px]">
          {/* TRADINGVIEW LEFT DRAWING TOOLBAR */}
          <div className="w-12 bg-white dark:bg-[#0b101a] border-r border-slate-300 dark:border-[#1a2030] flex flex-col items-center py-3 gap-2 shrink-0 select-none z-10">
            <button
              onClick={() => setActiveTool('POINTER')}
              className={`p-2 rounded-xl transition-colors cursor-pointer ${
                activeTool === 'POINTER' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-black dark:hover:text-white'
              }`}
              title="Crosshair / Pointer"
            >
              <Crosshair className="w-4 h-4" />
            </button>

            <button
              onClick={() => setActiveTool('POSITION_BOX')}
              className={`p-2 rounded-xl transition-colors cursor-pointer ${
                activeTool === 'POSITION_BOX' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-black dark:hover:text-white'
              }`}
              title="Long/Short Risk-Reward Box (TradingView Tool)"
            >
              <Target className="w-4 h-4" />
            </button>

            <button
              onClick={() => setActiveTool('TRENDLINE')}
              className={`p-2 rounded-xl transition-colors cursor-pointer ${
                activeTool === 'TRENDLINE' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-black dark:hover:text-white'
              }`}
              title="Trendline Tool"
            >
              <TrendingUp className="w-4 h-4" />
            </button>

            <button
              onClick={() => setActiveTool('RAY')}
              className={`p-2 rounded-xl transition-colors cursor-pointer ${
                activeTool === 'RAY' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-black dark:hover:text-white'
              }`}
              title="Horizontal Support/Resistance Line"
            >
              <Minus className="w-4 h-4" />
            </button>

            <button
              onClick={() => setActiveTool('RECTANGLE')}
              className={`p-2 rounded-xl transition-colors cursor-pointer ${
                activeTool === 'RECTANGLE' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-black dark:hover:text-white'
              }`}
              title="Order Block / FVG Rectangle Box"
            >
              <Square className="w-4 h-4" />
            </button>

            <div className="w-6 h-px bg-slate-200 dark:bg-slate-800 my-1" />

            <button
              onClick={() => setDrawings([])}
              className="p-2 rounded-xl text-slate-500 hover:text-rose-600 transition-colors cursor-pointer"
              title="Clear Custom Drawings"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          {/* Canvas Viewport */}
          <div ref={containerRef} className="flex-1 h-full relative bg-white dark:bg-[#07090e]">
            <canvas
              ref={canvasRef}
              onMouseMove={handleCanvasMouseMove}
              onMouseDown={handleCanvasMouseDown}
              onMouseLeave={() => setHoveredCandle(null)}
              className="w-full h-full cursor-crosshair block"
            />
          </div>
        </div>
      </div>

      {/* TRADINGVIEW-STYLE CUSTOMIZATION SETTINGS MODAL */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] rounded-2xl p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-[#1a2030]">
              <h3 className="text-base font-bold text-black dark:text-white flex items-center gap-2">
                <Settings2 className="w-4 h-4 text-blue-500" />
                Chart Style & Indicator Settings
              </h3>
              <button onClick={() => setShowSettingsModal(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              {/* Asia Box Opacity Slider */}
              <div className="space-y-1.5 p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-black dark:text-white">Asia Shaded Box Opacity</span>
                  <span className="font-mono font-bold text-blue-600">{Math.round(asiaOpacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.05"
                  max="0.50"
                  step="0.01"
                  value={asiaOpacity}
                  onChange={(e) => setAsiaOpacity(parseFloat(e.target.value))}
                  className="w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
              </div>

              {/* Position Box R:R Ratio */}
              <div className="space-y-1.5 p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-black dark:text-white">Risk-to-Reward Target (1 : R)</span>
                  <span className="font-mono font-bold text-emerald-600">1 : {targetMultiplier.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="1.0"
                  max="5.0"
                  step="0.5"
                  value={targetMultiplier}
                  onChange={(e) => setTargetMultiplier(parseFloat(e.target.value))}
                  className="w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-600"
                />
              </div>

              {/* Stop Loss Distance */}
              <div className="space-y-1.5 p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-black dark:text-white">Position Box Stop Loss Points</span>
                  <span className="font-mono font-bold text-rose-600">{stopLossPips} pts</span>
                </div>
                <input
                  type="number"
                  min="10"
                  max="500"
                  value={stopLossPips}
                  onChange={(e) => setStopLossPips(Math.max(5, parseFloat(e.target.value) || 5))}
                  className="w-full px-3 py-1.5 bg-white dark:bg-[#151922] border border-slate-300 dark:border-[#1a2030] rounded-lg font-mono font-bold text-black dark:text-white"
                />
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                type="button"
                onClick={() => setShowSettingsModal(false)}
                className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs transition-colors cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
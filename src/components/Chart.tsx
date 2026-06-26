import { useEffect, useRef, useCallback } from 'react';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import type { Kline } from '../services/api';
import { calculateBollingerBandsSeries } from '../utils/indicators';
import type { BollingerBandsSeriesResult } from '../utils/indicators';

interface ChartProps {
  data: Kline[];
  showBB?: boolean;
  symbol: string;
  interval: string;
}

export default function Chart({ data, showBB = false, symbol, interval }: ChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlestickSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const upperSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const middleSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const lowerSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  // Refs for the legend elements to perform direct, high-performance DOM updates
  const openRef = useRef<HTMLSpanElement>(null);
  const highRef = useRef<HTMLSpanElement>(null);
  const lowRef = useRef<HTMLSpanElement>(null);
  const closeRef = useRef<HTMLSpanElement>(null);
  const bbUpperRef = useRef<HTMLSpanElement>(null);
  const bbMiddleRef = useRef<HTMLSpanElement>(null);
  const bbLowerRef = useRef<HTMLSpanElement>(null);
  const bbWidthRef = useRef<HTMLSpanElement>(null);

  // References to keep data accessible in the crosshair Move handler without resetting the chart
  const dataRef = useRef<Kline[]>([]);
  const bbMapRef = useRef<Map<number, BollingerBandsSeriesResult>>(new Map());
  const showBBRef = useRef(showBB);
  const lastSymbolRef = useRef<string>(symbol);
  const intervalRef = useRef(interval);

  useEffect(() => {
    showBBRef.current = showBB;
  }, [showBB]);

  useEffect(() => {
    intervalRef.current = interval;
  }, [interval]);

  // Helper to format prices according to their magnitude
  const formatPrice = (value: number) => {
    if (value === null || value === undefined || isNaN(value)) return '-';
    if (value === 0) return '0.00';
    const absVal = Math.abs(value);
    if (absVal < 0.01) {
      return value.toFixed(6);
    } else if (absVal < 1) {
      return value.toFixed(4);
    } else {
      return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
  };

  // Helper to update the floating legend text and styles
  const updateLegendValues = useCallback((candle: Kline | null, bb: BollingerBandsSeriesResult | null) => {
    if (!openRef.current || !highRef.current || !lowRef.current || !closeRef.current) return;

    if (!candle) {
      openRef.current.innerText = '-';
      highRef.current.innerText = '-';
      lowRef.current.innerText = '-';
      closeRef.current.innerText = '-';
      closeRef.current.style.color = '';
      
      if (bbWidthRef.current && bbUpperRef.current && bbMiddleRef.current && bbLowerRef.current) {
        bbUpperRef.current.innerText = '-';
        bbMiddleRef.current.innerText = '-';
        bbLowerRef.current.innerText = '-';
        bbWidthRef.current.innerText = '-';
        bbWidthRef.current.style.color = '';
      }
      return;
    }

    openRef.current.innerText = formatPrice(candle.open);
    highRef.current.innerText = formatPrice(candle.high);
    lowRef.current.innerText = formatPrice(candle.low);
    closeRef.current.innerText = formatPrice(candle.close);

    const isBullish = candle.close >= candle.open;
    closeRef.current.style.color = isBullish ? 'var(--accent-green, #00ff00)' : 'var(--accent-red, #ff0000)';

    if (showBBRef.current && bbWidthRef.current && bbUpperRef.current && bbMiddleRef.current && bbLowerRef.current) {
      if (bb) {
        bbUpperRef.current.innerText = formatPrice(bb.upper);
        bbMiddleRef.current.innerText = formatPrice(bb.middle);
        bbLowerRef.current.innerText = formatPrice(bb.lower);
        
        const widthVal = bb.widthPercent;
        bbWidthRef.current.innerText = `${widthVal.toFixed(2)}%`;
        
        const currentInterval = intervalRef.current;
        let threshold = 1.5; // Default for 5m and others
        if (currentInterval === '1h') {
          threshold = 8.0;
        } else if (currentInterval === '1d') {
          threshold = 10.0;
        }

        if (widthVal > threshold) {
          bbWidthRef.current.style.color = '#ffa500'; // Amber/Orange warning color
          bbWidthRef.current.innerText = `${widthVal.toFixed(2)}% (Expansion ⚠️)`;
        } else {
          bbWidthRef.current.style.color = 'var(--text-secondary, #888888)';
        }
      } else {
        bbUpperRef.current.innerText = '-';
        bbMiddleRef.current.innerText = '-';
        bbLowerRef.current.innerText = '-';
        bbWidthRef.current.innerText = '-';
        bbWidthRef.current.style.color = '';
      }
    }
  }, []);

  // 1. Initialize Chart (Run once on mount)
  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#888888',
      },
      grid: {
        vertLines: { color: '#333333' },
        horzLines: { color: '#333333' },
      },
      width: container.clientWidth,
      height: container.clientHeight,
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        mode: 0,
      },
      localization: {
        timeFormatter: (timestamp: number) => {
          const date = new Date(timestamp * 1000);
          return date.toLocaleString([], {
            month: '2-digit',
            day:   '2-digit',
            hour:  '2-digit',
            minute:'2-digit',
            hour12: false,
          });
        },
      },
    });

    chartRef.current = chart;

    candlestickSeriesRef.current = chart.addCandlestickSeries({
      upColor: '#00ff00',
      downColor: '#ff0000',
      borderVisible: false,
      wickUpColor: '#00ff00',
      wickDownColor: '#ff0000',
    });
    
    volumeSeriesRef.current = chart.addHistogramSeries({
      color: '#26a69a',
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: '', 
    });

    upperSeriesRef.current = chart.addLineSeries({
      color: 'rgba(33, 150, 243, 0.45)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });

    middleSeriesRef.current = chart.addLineSeries({
      color: 'rgba(255, 152, 0, 0.4)',
      lineWidth: 1,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });

    lowerSeriesRef.current = chart.addLineSeries({
      color: 'rgba(33, 150, 243, 0.45)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });

    chart.priceScale('').applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    // Crosshair Move listener to update the floating legend
    chart.subscribeCrosshairMove((param) => {
      if (
        !param.point || 
        !param.time || 
        param.point.x < 0 || 
        param.point.x > container.clientWidth || 
        param.point.y < 0 || 
        param.point.y > container.clientHeight
      ) {
        // Falling back to the latest candle when not hovering
        const latestCandle = dataRef.current[dataRef.current.length - 1];
        const latestBB = latestCandle ? bbMapRef.current.get(latestCandle.time as number) || null : null;
        updateLegendValues(latestCandle || null, latestBB);
        return;
      }

      const timeVal = param.time as number;
      const candleData = param.seriesData.get(candlestickSeriesRef.current!) as { open: number; high: number; low: number; close: number } | undefined;
      
      let candle: Kline | null = null;
      if (candleData) {
        candle = {
          time: timeVal,
          open: candleData.open,
          high: candleData.high,
          low: candleData.low,
          close: candleData.close,
          volume: 0
        };
      }
      
      const bb = bbMapRef.current.get(timeVal) || null;
      updateLegendValues(candle, bb);
    });

    const handleMouseLeave = () => {
      const latestCandle = dataRef.current[dataRef.current.length - 1];
      const latestBB = latestCandle ? bbMapRef.current.get(latestCandle.time as number) || null : null;
      updateLegendValues(latestCandle || null, latestBB);
    };

    container.addEventListener('mouseleave', handleMouseLeave);

    const handleResize = () => {
      if (container && chartRef.current) {
        chartRef.current.applyOptions({
          width: container.clientWidth,
          height: container.clientHeight,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (container) {
        container.removeEventListener('mouseleave', handleMouseLeave);
      }
      chart.remove();
    };
  }, [updateLegendValues]);

  // 2. Update Data (Run when data, showBB, or symbol changes)
  useEffect(() => {
    if (
      data &&
      data.length > 0 &&
      candlestickSeriesRef.current &&
      volumeSeriesRef.current &&
      upperSeriesRef.current &&
      middleSeriesRef.current &&
      lowerSeriesRef.current
    ) {
      const symbolChanged = lastSymbolRef.current !== symbol;
      if (symbolChanged) {
        lastSymbolRef.current = symbol;
        if (chartRef.current) {
          chartRef.current.priceScale('right').applyOptions({
            autoScale: true,
          });
        }
      }

      candlestickSeriesRef.current.setData(data as unknown as Parameters<ISeriesApi<'Candlestick'>['setData']>[0]);
      volumeSeriesRef.current.setData(data.map(k => ({
        time: k.time as Time,
        value: k.volume,
        color: k.close >= k.open ? 'rgba(0, 255, 0, 0.15)' : 'rgba(255, 0, 0, 0.15)'
      })));

      const newBbMap = new Map<number, BollingerBandsSeriesResult>();
      if (showBB) {
        const bbData = calculateBollingerBandsSeries(data);
        bbData.forEach(d => {
          newBbMap.set(d.time as number, d);
        });
        upperSeriesRef.current.setData(bbData.map(d => ({ time: d.time as Time, value: d.upper })));
        middleSeriesRef.current.setData(bbData.map(d => ({ time: d.time as Time, value: d.middle })));
        lowerSeriesRef.current.setData(bbData.map(d => ({ time: d.time as Time, value: d.lower })));
      } else {
        upperSeriesRef.current.setData([]);
        middleSeriesRef.current.setData([]);
        lowerSeriesRef.current.setData([]);
      }
      
      bbMapRef.current = newBbMap;
      dataRef.current = data;

      if (symbolChanged && chartRef.current) {
        chartRef.current.timeScale().fitContent();
      }

      // Update legend with latest candle's values after DOM updates
      const latestCandle = data[data.length - 1];
      const latestBB = showBB ? newBbMap.get(latestCandle.time as number) || null : null;
      const timer = setTimeout(() => {
        updateLegendValues(latestCandle, latestBB);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [data, showBB, symbol, updateLegendValues]);

  return (
    <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}>
      {/* Floating Legend Overlay */}
      <div
        style={{
          position: 'absolute',
          top: '12px',
          left: '12px',
          zIndex: 10,
          backgroundColor: 'rgba(20, 20, 20, 0.8)',
          backdropFilter: 'blur(6px)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: '4px',
          padding: '6px 12px',
          fontFamily: 'Inter, sans-serif',
          fontSize: '11px',
          color: '#d1d5db',
          pointerEvents: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
          minWidth: '240px',
        }}
      >
        {/* OHLC Values */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span>O: <span ref={openRef} style={{ fontWeight: '600', color: '#f3f4f6' }}>-</span></span>
          <span>H: <span ref={highRef} style={{ fontWeight: '600', color: '#f3f4f6' }}>-</span></span>
          <span>L: <span ref={lowRef} style={{ fontWeight: '600', color: '#f3f4f6' }}>-</span></span>
          <span>C: <span ref={closeRef} style={{ fontWeight: '600' }}>-</span></span>
        </div>
        
        {/* Bollinger Bands Values */}
        {showBB && (
          <div
            style={{
              display: 'flex',
              gap: '6px',
              flexWrap: 'wrap',
              alignItems: 'center',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
              paddingTop: '4px',
              marginTop: '2px',
            }}
          >
            <span style={{ color: 'rgba(255, 152, 0, 0.9)', fontWeight: 'bold' }}>BB(20, 2)</span>
            <span style={{ color: '#888888' }}>U:</span>
            <span ref={bbUpperRef} style={{ color: 'rgba(33, 150, 243, 0.85)' }}>-</span>
            <span style={{ color: '#888888' }}>M:</span>
            <span ref={bbMiddleRef} style={{ color: 'rgba(255, 152, 0, 0.75)' }}>-</span>
            <span style={{ color: '#888888' }}>L:</span>
            <span ref={bbLowerRef} style={{ color: 'rgba(33, 150, 243, 0.85)' }}>-</span>
            
            <span style={{ color: '#888888', marginLeft: '6px' }}>Width:</span>
            <span ref={bbWidthRef} style={{ fontWeight: 'bold', transition: 'color 0.2s' }}>-</span>
          </div>
        )}
      </div>

      <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

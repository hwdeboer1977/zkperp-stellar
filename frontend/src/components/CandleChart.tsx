// BTC-USD candles from Coinbase (REST + live WebSocket ticker), with the vault's
// execution price as a dashed violet line and your levels as dotted lines.
// Same data source and look as zkperp-midnight's chart.
import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";

export const INTERVALS: [string, number][] = [["5m", 300], ["15m", 900], ["1h", 3600], ["6h", 21600], ["1D", 86400]];
interface Candle { time: UTCTimestamp; open: number; high: number; low: number; close: number }
export interface Level { price: number; title: string; color: string }

export function CandleChart({ granularity, execution, levels = [], onLive }: { granularity: number; execution?: number; levels?: Level[]; onLive?: (p: number, first: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const data = useRef<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const v = (n: string) => css.getPropertyValue(n).trim();
    const c = createChart(box.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: v("--muted"), fontFamily: v("--mono"), fontSize: 11 },
      grid: { vertLines: { color: v("--border") }, horzLines: { color: v("--border") } },
      rightPriceScale: { borderColor: v("--border") }, timeScale: { borderColor: v("--border"), timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
    });
    series.current = c.addSeries(CandlestickSeries, { upColor: v("--good"), wickUpColor: v("--good"), downColor: v("--bad"), wickDownColor: v("--bad"), borderVisible: false });
    chart.current = c;
    return () => { c.remove(); chart.current = null; };
  }, []);

  useEffect(() => {
    let live = true, ws: WebSocket | null = null, first = true;
    const load = async () => {
      try {
        const r = await fetch(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${granularity}`);
        const rows: number[][] = await r.json();
        if (!live) return;
        data.current = rows.reverse().map(([t, low, high, open, close]) => ({ time: t as UTCTimestamp, open, high, low, close }));
        series.current?.setData(data.current);
        if (first) { chart.current?.timeScale().fitContent(); first = false; }
        setLoading(false); setError(null);
      } catch { setError("Market data unavailable (Coinbase)."); }
    };
    load();
    const t = setInterval(load, 60_000);
    const connect = () => {
      ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
      ws.onopen = () => ws?.send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker"] }));
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.type !== "ticker" || !data.current.length) return;
        const p = Number(d.price), now = Math.floor(Date.now() / 1000);
        const start = (now - (now % granularity)) as UTCTimestamp;
        const last = data.current[data.current.length - 1];
        const bar = last.time === start ? { ...last, close: p, high: Math.max(last.high, p), low: Math.min(last.low, p) } : { time: start, open: last.close, high: Math.max(last.close, p), low: Math.min(last.close, p), close: p };
        if (last.time === start) data.current[data.current.length - 1] = bar; else data.current.push(bar);
        series.current?.update(bar);
        onLive?.(p, data.current[0].open);
      };
      ws.onclose = () => live && setTimeout(connect, 5000);
    };
    connect();
    return () => { live = false; clearInterval(t); ws?.close(); };
  }, [granularity, onLive]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    lines.current.forEach((l) => s.removePriceLine(l));
    lines.current = [];
    if (execution) lines.current.push(s.createPriceLine({ price: execution, color: "#8b6cff", lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "execution" }));
    for (const l of levels) lines.current.push(s.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: l.title }));
  }, [execution, levels]);

  return (
    <div className="candles-box" ref={box}>
      {(loading || error) && <div className="overlay">{error ?? "Loading BTC/USD market data…"}</div>}
    </div>
  );
}

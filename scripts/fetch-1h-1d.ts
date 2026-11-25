// scripts/fetch-1h-1d.ts — descarga ~730 días de velas 1h y 5 años de velas 1d de Yahoo
// (mismo universo que scripts/fetch-fresh-5m.ts) para la validación de motores en 1h.
// Uso: npx tsx scripts/fetch-1h-1d.ts
import * as fs from 'fs';
import * as path from 'path';
const SYMBOLS = fs.readdirSync(path.resolve(process.cwd(), 'scratch/fresh-5m-20261015')).map(f => f.replace('.json', ''));
const nowSec = Date.now() / 1000;
async function get(symbol: string, range: string, interval: string, stepSec: number, out: string) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
  if (!res.ok) return `HTTP ${res.status}`;
  const j: any = await res.json(); const r = j.chart?.result?.[0]; if (!r?.timestamp) return 'sin datos';
  const q = r.indicators.quote[0]; const k: any[] = [];
  r.timestamp.forEach((t: number, i: number) => { const b = { time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] ?? 0 };
    // Solo velas completas (la vela en formación queda fuera)
    if ([b.open, b.high, b.low, b.close].every(v => typeof v === 'number' && Number.isFinite(v)) && t + stepSec <= nowSec) k.push(b); });
  fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, `${symbol}.json`), JSON.stringify(k));
  return `${k.length} velas desde ${new Date(k[0].time * 1000).toISOString().slice(0, 10)}`;
}
for (const s of SYMBOLS) {
  const a = await get(s, '730d', '1h', 3600, 'scratch/h1-20261015').catch(e => 'ERR ' + e.message);
  const b = await get(s, '5y', '1d', 86400, 'scratch/d1-20261015').catch(e => 'ERR ' + e.message);
  console.log(s.padEnd(6), '1h:', a, '| 1d:', b);
  await new Promise(r => setTimeout(r, 300));
}

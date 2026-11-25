/**
 * scripts/fetch-crypto-klines.ts — downloads closed Binance klines (public API) to scratch/.
 * Usage: npx tsx scripts/fetch-crypto-klines.ts <interval> <bars> <outDir>
 */
import * as fs from 'fs';
import * as path from 'path';
const [interval = '5m', barsArg = '8000', outDir = `scratch/crypto-${interval}`] = process.argv.slice(2);
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'LTCUSDT', 'DOTUSDT', 'TRXUSDT'];
const bars = Number(barsArg);
fs.mkdirSync(outDir, { recursive: true });
for (const s of SYMBOLS) {
  let end: number | undefined; const rows: number[][] = [];
  while (rows.length < bars) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${interval}&limit=1000${end ? `&endTime=${end}` : ''}`;
    const res = await fetch(url); if (!res.ok) { console.log(s, res.status); break; }
    const page = await res.json() as (string | number)[][]; if (!page.length) break;
    rows.unshift(...page.map(r => r.map(Number)));
    end = Number(page[0][0]) - 1;
    await new Promise(r => setTimeout(r, 200));
  }
  const now = Date.now();
  const k = rows.filter(r => r[6] < now).slice(-bars)
    .map(r => ({ time: Math.floor(r[0] / 1000), open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
  fs.writeFileSync(path.join(outDir, `${s}.json`), JSON.stringify(k));
  console.log(s, k.length);
}

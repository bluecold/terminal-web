/**
 * scripts/fetch-earnings-calendar.ts — Nasdaq earnings calendar per day (public API) to scratch/.
 * Usage: npx tsx scripts/fetch-earnings-calendar.ts <from YYYY-MM-DD> <to YYYY-MM-DD> <outDir>
 */
import * as fs from 'fs';
import * as path from 'path';
const [from = '2026-07-20', to = '2026-11-04', outDir = 'scratch/earnings-nasdaq'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
for (let ms = Date.parse(from + 'T00:00:00Z'); ms <= Date.parse(to + 'T00:00:00Z'); ms += 86400000) {
  const d = new Date(ms); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
  const key = d.toISOString().slice(0, 10); const f = path.join(outDir, `${key}.json`);
  if (fs.existsSync(f)) continue;
  const res = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${key}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', Accept: 'application/json' } });
  if (!res.ok) { console.log(key, res.status); continue; }
  const j = await res.json() as { data?: { rows?: { symbol: string; time: string }[] } };
  const rows = (j.data?.rows ?? []).map(r => ({ symbol: r.symbol, time: r.time }));
  fs.writeFileSync(f, JSON.stringify(rows));
  await new Promise(r => setTimeout(r, 250));
}

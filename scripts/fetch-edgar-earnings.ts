/**
 * scripts/fetch-edgar-earnings.ts
 *
 * Earnings release timestamps from SEC EDGAR: 8-K filings with Item 2.02 ("Results of Operations")
 * and their acceptance time. Public data, no key. Output: scratch/edgar-earnings.json as
 * { [symbol]: [{ acceptance: ISO-UTC, filingDate }] }.
 *
 * Usage: npx tsx scripts/fetch-edgar-earnings.ts <symbolsDir> [from YYYY-MM-DD] [to YYYY-MM-DD]
 */
import * as fs from 'fs';

const [symbolsDir = 'scratch/fresh-5m-20261103', from = '2026-07-01', to = '2026-11-05'] = process.argv.slice(2);
const OUT = 'scratch/edgar-earnings.json';
const UA = 'FinceptTerminal research script';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const symbols = fs.readdirSync(symbolsDir).map(f => f.replace('.json', '')).filter(s => !s.includes('USDT'));
const out: Record<string, { acceptance: string; filingDate: string }[]> = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

for (const sym of symbols) {
  if (out[sym]) continue;
  try {
    const s = await fetch(`https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(sym)}`, { headers: { 'User-Agent': UA } });
    const hits = ((await s.json()) as { hits?: { hits?: { _id: string; _source: { tickers?: string } }[] } }).hits?.hits ?? [];
    const hit = hits.find(h => (h._source.tickers ?? '').split(',').map(t => t.trim()).includes(sym));
    await sleep(150);
    if (!hit) { console.log(sym, 'sin CIK'); out[sym] = []; continue; }
    const cik = hit._id.padStart(10, '0');
    const r = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { 'User-Agent': UA } });
    const recent = ((await r.json()) as { filings: { recent: { form: string[]; items: string[]; filingDate: string[]; acceptanceDateTime: string[] } } }).filings.recent;
    const events: { acceptance: string; filingDate: string }[] = [];
    for (let i = 0; i < recent.form.length; i++) {
      if (!recent.form[i].startsWith('8-K') || !String(recent.items[i]).split(',').includes('2.02')) continue;
      if (recent.filingDate[i] < from || recent.filingDate[i] > to) continue;
      events.push({ acceptance: recent.acceptanceDateTime[i], filingDate: recent.filingDate[i] });
    }
    out[sym] = events;
    console.log(sym, events.length);
  } catch (e) { console.log(sym, 'ERR', (e as Error).message); }
  await sleep(150);
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

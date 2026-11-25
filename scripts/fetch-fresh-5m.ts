// scripts/fetch-fresh-5m.ts — descarga 60 días de velas 5m de Yahoo para la validación OOS de Confluencia.
// Uso: npx tsx scripts/fetch-fresh-5m.ts
import * as fs from 'fs';
import * as path from 'path';
const OUT = path.resolve(process.cwd(), 'scratch/fresh-5m-20261015');
const OLD = ['AMD','ASTS','AVGO','COIN','HUT','IBIT','INTC','IREN','KEEL','MRVL','MSFT','MSTR','MU','NVDA','RIOT','RKLB','SATL','SNDK','SPCE','SPCX','TSLA',
 'AAPL','AMZN','GOOGL','META','SPY','QQQ','NFLX','BABA','PLTR','JPM','UBER','CRM','ORCL','ADBE','QCOM','SHOP','XOM','CVX','BAC','WFC','GS','DIS','NKE','BA','CAT','LLY','UNH','COST','WMT','HOOD','SMCI','ARM','SOFI','RIVN','MARA','SNOW'];
const NEW = ['CLSK','CIFR','WULF','BITF','OKLO','SMR','NBIS','CRWV','APP','RDDT','AFRM','UPST','DKNG','ROKU','NET','CRWD','PANW','DDOG','ZS','MDB','TTD','ENPH','FSLR','LCID','NIO','PYPL','PFE','KO','PEP','JNJ','HD','MCD','V','MA','TXN','LRCX','AMAT','KLAC','ON','ACHR','JOBY','LUNR','RGTI','IONQ','QBTS','SOUN','BBAI','TEM','HIMS','CVNA'];
fs.mkdirSync(OUT, { recursive: true });
const nowSec = Date.now() / 1000;
for (const s of [...OLD, ...NEW]) {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?range=60d&interval=5m`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
    if (!res.ok) { console.log(s, 'HTTP', res.status); continue; }
    const j: any = await res.json(); const r = j.chart?.result?.[0]; if (!r?.timestamp) { console.log(s, 'sin datos'); continue; }
    const q = r.indicators.quote[0]; const k: any[] = [];
    r.timestamp.forEach((t: number, i: number) => { const b = { time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] ?? 0 };
      if ([b.open, b.high, b.low, b.close].every(v => typeof v === 'number' && Number.isFinite(v)) && t % 300 === 0 && t + 300 <= nowSec) k.push(b); });
    fs.writeFileSync(path.join(OUT, `${s}.json`), JSON.stringify(k));
    console.log(s, k.length, new Date(k[0].time * 1000).toISOString().slice(0, 10), new Date(k.at(-1).time * 1000).toISOString().slice(0, 16));
  } catch (e) { console.log(s, 'ERR', (e as Error).message); }
  await new Promise(r => setTimeout(r, 300));
}

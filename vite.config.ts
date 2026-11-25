import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import https from 'node:https'
import dns from 'node:dns'

// In-memory DNS cache to eliminate repeated getaddrinfo lookups during burst scans
// and prevent transient ENOTFOUND / DNS timeout errors on Windows.
const dnsCache = new Map<string, { address: string; family: number; timestamp: number }>()
const DNS_CACHE_TTL_MS = 60_000 // 60s TTL

function cachedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
) {
  const cached = dnsCache.get(hostname)
  const now = Date.now()
  if (cached && now - cached.timestamp < DNS_CACHE_TTL_MS) {
    if (typeof options === 'object' && options.all) {
      return callback(null, [{ address: cached.address, family: cached.family }])
    }
    return callback(null, cached.address, cached.family)
  }

  dns.lookup(hostname, options, (err, address, family) => {
    if (!err && address) {
      const addr = Array.isArray(address) ? address[0]?.address : address
      const fam = Array.isArray(address) ? address[0]?.family : (family || 4)
      if (addr) {
        dnsCache.set(hostname, { address: addr, family: fam, timestamp: now })
      }
      return callback(null, address, family)
    }

    // Graceful fallback to stale cache entry if live DNS resolution times out / glitches
    if (err && cached) {
      if (typeof options === 'object' && options.all) {
        return callback(null, [{ address: cached.address, family: cached.family }])
      }
      return callback(null, cached.address, cached.family)
    }

    callback(err, address, family)
  })
}

const yahooAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60_000,
  maxSockets: 30,
  maxFreeSockets: 10,
  timeout: 20_000,
  lookup: cachedLookup as unknown as https.AgentOptions['lookup'],
})

const zacksAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60_000,
  maxSockets: 10,
  timeout: 15_000,
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/lightweight-charts/')) {
            return 'vendor-charts';
          }
          if (id.includes('node_modules/lucide-react/')) {
            return 'vendor-icons';
          }
        },
      },
    },
  },
  server: {
    proxy: {
      '/api/yahoo': {
        target: 'https://query1.finance.yahoo.com', // query1 es mucho más rápido y confiable (3s vs 48s de query2)
        changeOrigin: true,
        agent: yahooAgent,
        rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        },
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            console.warn(`[Vite Proxy] Yahoo Finance upstream warning: ${err.message}`)
            if (res && 'writeHead' in res && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Yahoo Proxy Temporary Gateway Error', details: err.message }))
            }
          })
        }
      },
      '/api/nasdaq': {
        target: 'https://api.nasdaq.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nasdaq/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            console.warn(`[Vite Proxy] Nasdaq upstream warning: ${err.message}`)
            if (res && 'writeHead' in res && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Nasdaq Proxy Temporary Gateway Error', details: err.message }))
            }
          })
        }
      },
      '/api/zacks': {
        target: 'https://quote-feed.zacks.com',
        changeOrigin: true,
        agent: zacksAgent,
        rewrite: (path) => path.replace(/^\/api\/zacks/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            console.warn(`[Vite Proxy] Zacks upstream warning: ${err.message}`)
            if (res && 'writeHead' in res && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Zacks Proxy Temporary Gateway Error', details: err.message }))
            }
          })
        }
      }
    }
  }
})

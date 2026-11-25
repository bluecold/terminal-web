# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

FinceptTerminal ("TERMINAL LITE" in the UI) is a client-only React 19 + TypeScript + Vite app that generates short-term trading alerts for US equities (Yahoo Finance) and crypto (Binance). All signal logic, backtesting and alert tracking run in the browser; there is no backend. Yahoo/Zacks/Nasdaq requests go through `/api/yahoo`, `/api/zacks` and `/api/nasdaq` proxies (`vite.config.ts` in dev, `vercel.json` rewrites in production). User-facing text, README and `AI_CONTEXT.md` are in Spanish. `AI_CONTEXT.md` is a long historical changelog; prefer the code as the source of truth.

## Commands

```bash
npm run dev          # Vite dev server
npm run build        # tsc -b && vite build
npm run lint         # eslint .
npm test             # all suites (backtester harness + node:test suites), ~5 s
npm run test:types   # typecheck tests/benchmark with tsconfig.execution-tests.json
```

Running a subset of tests:

```bash
# node:test suites (everything in src/utils/__tests__ except backtester.test.ts)
npx tsx --tsconfig tsconfig.execution-tests.json --test src/utils/__tests__/confluencia.test.ts
npx tsx --tsconfig tsconfig.execution-tests.json --test --test-name-pattern="Candidate cascade" src/utils/__tests__/scannerPipeline.test.ts

# backtester.test.ts uses its own harness (no name filter; runs the whole file)
npx tsx src/utils/__tests__/backtester.test.ts
```

All `*.test.ts` files in `src/utils/__tests__/` are discovered and executed automatically by `scripts/run-all-tests.ts` when running `npm test`. Coverage: add `--experimental-test-coverage --test-coverage-include="src/**"` to the node:test command.

`causality.test.ts` (helpers in `__tests__/helpers/causality.ts`) runs freqtrade-style lookahead and history-sensitivity checks over all six evaluators; when adding or changing an evaluator, keep it passing. `scripts/causality-analysis.ts` runs the same checks on real data in `scratch/`.

`scripts/` holds reproducible research/benchmark scripts run with `npx tsx scripts/<name>.ts`. `scratch/` is gitignored local research data.

## Architecture

### Signal pipeline (shared by scanner, radar and panel)

The same chain is used by the background alert scanner (`hooks/useScanner.ts`), `MarketRadar.tsx` and `SignalPanel.tsx`; keep them in parity by changing the shared functions, not the components:

1. **Evaluators** (`utils/strategyEvaluators.ts`): pure `build*Context` + `evaluate*At(ctx, i)` for the six engines — Confluencia (named `calculateExperimentalSignal` / "Experimental" in older code), Scoring, Standard Voting, VCME Sniper (`multitemporal` key), Multifractal MTF and MFLS. `indicators.ts` holds the indicators and the NYSE calendar/session helpers; `strategySignals.ts` holds the live `calculate*Signal` wrappers and MTF context caches. Dependencies are one-way (indicators ← strategyEvaluators ← strategySignals); keep `src/` free of import cycles. Scoring S/R checkpoints are anchored to candle time, so every engine gives the same signal wherever the downloaded series starts.
2. **Backtests** (`utils/backtester.ts`): every engine is backtested with the same evaluator (live/backtest parity), simulated through `tradeSimulator.ts` → `executionEngine.ts` (fills, partials, trailing, time stops, friction 0.11% + 0.03% slippage via `tradeLevels.ts`). Results include walk-forward (70/30, 3 OOS folds), directional and regime stats.
3. **Tournament** (`utils/tournament.ts`): `runQVESelection` backtests all engines for a symbol and `evaluateStrategyTournament` ranks them (Bayesian shrinkage, multiplicity deflation, WF gates, ADX regime with 22/26 hysteresis).
4. **Candidate queue → cascade → emission**: `buildStrategyCandidateQueue` (actionable candidates, Standard exploratory fallback, informational engines), `resolveCandidateCascade` (first candidate whose `resolveOperationalTrade` plan in `operationalTrade.ts` is valid), and `evaluateAlertEmission` in `alertEmission.ts` (exploratory opt-in, open position, NYSE session, closing candle, candle dedup, cooldown).
5. **Tracking** (`utils/alertTracker.ts`): alerts persist in localStorage with a resumable `executionState` checkpoint; outcomes are re-simulated as new candles arrive. Closed alerts are archived 90 days by `alertReport.ts` for the INFORME modal.

### 5m equities policy (key domain rule)

Measured on a 21-symbol watchlist over 60 days, only Confluencia was net positive on US equities at 5m (+0.06R), but that edge did not hold out of sample (Oct 2026: new sessions and 49 unseen symbols, see `scripts/confluencia-volatility-oos.ts`); it remains the alerting engine as the least-bad one. Therefore, for `targetInterval === '5m'` and non-crypto symbols:
- Confluencia only fires on candles opening 09:35–10:55 ET (`isNyseOpeningHour`), only when ATR(14) ≥ 0.5% of the price (`CONFLUENCIA_EQUITY_5M_MIN_ATR_PCT`; quieter setups lost −0.23R to −0.32R out of sample), and is vetoed per symbol only for decisively toxic history (`getEquity5mActionableCandidates`).
- Standard, Scoring, VCME, Multifractal and MFLS are **informational** (`isInformationalStrategy`): excluded from the tournament winner and from PRIMARY alerts, surfaced as `(Informativa)` candidates with confidence `NONE` (logged as EXPLORATORY alerts only when the user enables 🔬, i.e. localStorage `terminal_exploratory_alerts`).
- The leader shown in radar/panel comes from `resolveTournamentLeader`, not directly from the tournament.
Crypto, 1h and 1d keep the full tournament, but on 1h equities no engine has edge either: `scripts/engines-1h-validation.ts` (106 symbols, Nov 2023–Oct 2026, 0.11% same-day / 0.22% overnight) gives negative net and ≈0 or negative gross E[R] for Confluencia, Scoring, Standard and VCME swing. Tournament confidence is therefore labelled in the UI as "Backtest favorable" / "muestra limitada", never as validated edge. Changes to strategy rules should be validated with net-of-cost backtests across the watchlist (both halves of the sample) and out of sample (later sessions and unseen symbols), not single-symbol results.

### Data and timing

- `services/api.ts` fetches and caches klines (`fetchWithDeduplication`); intraday cache entries expire at each candle boundary (`getKlineCacheBoundaryMs`). Yahoo 1h uses `range=730d` with a `2y` fallback. `sanitizeKlines` enforces OHLC geometry and ordering.
- Signals only use closed candles: `getConfirmedClosedKlines` decides closure from the snapshot acquisition time stamped by `marketDataSnapshot.ts`; higher timeframes are mapped only once closed.
- The scanner and radar run 8 s after each minute boundary (`scanSchedule.ts`), so a 5m close is evaluated within seconds; entry delay materially erodes Confluencia's edge.

### UI

`App.tsx` owns global state (watchlist, alerts log, cooldowns, discard telemetry); the background scanner lives in `hooks/useScanner.ts` and app-shell localStorage keys/accessors in `utils/settings.ts`. `SignalPanel.tsx` (right panel, strategy cards with INFORMATIVA/LÍDER badges), `MarketRadar.tsx` (multi-asset table; its "Alineación Estándar 5m·1h·1d" matrix is Standard Voting, not Confluencia), `HelpModal.tsx` (guide opened from the logo; update it with user-visible behavior changes), `AlertReportModal.tsx` (INFORME). The app version lives in `src/version.ts` and `package.json` (`vYYYY.MM.DD.N`).

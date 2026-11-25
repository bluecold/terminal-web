/**
 * Background alert scanner (moved out of App.tsx without changing its logic).
 * Runs only in the leader tab, 8 s after each minute boundary (scanSchedule.ts), on tab focus and
 * right after a scan that was requested while another one was running. For every watchlist, current
 * or tracked symbol it runs the shared pipeline (tournament → six engines → candidate queue →
 * operational cascade → emission gates), logs/notifies the emitted alert and re-simulates outcomes.
 */
import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { fetchKlines, type Kline } from '../services/api';
import { getConfirmedClosedKlines, getEffectiveExecutionPrice, type ScoringWeights } from '../utils/indicators';
import {
  calculateStandardVoting,
  calculateExperimentalSignal,
  calculateScoringSignal,
  calculateVCMESniperSignal,
  calculateMultifractalMTFSignal,
  calculateMFLSSignal,
} from '../utils/strategySignals';
import { resolveOperationalTrade } from '../utils/operationalTrade';
import { isCryptoAsset } from '../utils/tradeLevels';
import { runQVESelection, buildStrategyCandidateQueue, resolveCandidateCascade } from '../utils/tournament';
import { evaluateAlertEmission } from '../utils/alertEmission';
import { APP_VERSION } from '../version';
import { getMsUntilNextAlignedScan } from '../utils/scanSchedule';
import { computeAlertLatencySec } from '../utils/alertReport';
import {
  isCandleAlertFired,
  registerFiredCandleAlert,
  generateCandleAlertKey,
  getAlertCooldownKey,
  type AuditAlertItem,
} from '../utils/alertTracker';
import type { LiveDiscardReason } from '../utils/liveDiscards';
import type { AlertCooldownRecord } from '../utils/radarFilters';
import { buildAlertEventNotice, type EarningsEvent } from '../utils/marketEvents';
import { formatSmartPrice } from '../utils/formatters';
import { areDesktopNotificationsEnabled, isExploratoryLoggingEnabled, isExploratoryNotificationEnabled } from '../utils/settings';

export interface UseScannerParams {
  /** Only the leader tab scans (see scannerLeadership.ts). */
  isScannerLeader: boolean;
  watchlistSymbols: string[];
  currentAsset: string;
  interval: string;
  executionStyle: 'dayTrading' | 'swing';
  triggerMode: 'agresivo' | 'conservador';
  scoringWeights: ScoringWeights;
  alertsLogRef: MutableRefObject<AuditAlertItem[]>;
  alertCooldownsRef: MutableRefObject<Record<string, number | AlertCooldownRecord>>;
  earningsEventsRef: MutableRefObject<Record<string, EarningsEvent>>;
  setAlertsLog: Dispatch<SetStateAction<AuditAlertItem[]>>;
  syncAlertOutcomesAndCooldowns: (prevAlerts: AuditAlertItem[], klinesMap: Record<string, Kline[]>, targetSymbol?: string) => AuditAlertItem[];
  setAlertCooldown: (key: string, timestamp: number, outcome?: string) => void;
  recordDiscard: (symbol: string, interval: string, candleTimestamp: number, reason: LiveDiscardReason) => void;
}

const MAX_CONCURRENT_SYMBOL_SCANS = 4;

/** Returns the local time (HH:MM) of the last completed scan pass. */
export function useScanner({
  isScannerLeader,
  watchlistSymbols,
  currentAsset,
  interval,
  executionStyle,
  triggerMode,
  scoringWeights,
  alertsLogRef,
  alertCooldownsRef,
  earningsEventsRef,
  setAlertsLog,
  syncAlertOutcomesAndCooldowns,
  setAlertCooldown,
  recordDiscard,
}: UseScannerParams): { lastScanTime: string | null } {
  // recordDiscard only touches refs and a state setter; keep the latest one without restarting the scanner.
  const recordDiscardRef = useRef(recordDiscard);
  useEffect(() => {
    recordDiscardRef.current = recordDiscard;
  }, [recordDiscard]);



  // Timestamp of the last completed scanner run (task #4)
  const [lastScanTime, setLastScanTime] = useState<string | null>(null);

  // Avoid overlapping scans when a full watchlist pass takes longer than the
  // scheduler interval, and keep network concurrency below provider limits.
  const scannerRunningRef = useRef(false);
  // A scan requested while another is running is replayed right after it, so a candle close
  // is never skipped until the next minute.
  const scanPendingRef = useRef(false);

  useEffect(() => {
    if (!isScannerLeader) return;
    let isMounted = true;

    const checkAllSignals = async () => {
      if (scannerRunningRef.current) {
        scanPendingRef.current = true;
        return;
      }

      scannerRunningRef.current = true;
      try {
      const activeAlertSymbols = alertsLogRef.current
        .filter(a => a.status === 'OPEN' || a.status === 'TP1_HIT' || a.status === 'TP2_HIT')
        .map(a => a.symbol);
      const symbolsToScan = Array.from(new Set([...watchlistSymbols, currentAsset, ...activeAlertSymbols]));
      const scannedKlinesMap: Record<string, Kline[]> = {};

      for (let batchStart = 0; batchStart < symbolsToScan.length; batchStart += MAX_CONCURRENT_SYMBOL_SCANS) {
        const batch = symbolsToScan.slice(batchStart, batchStart + MAX_CONCURRENT_SYMBOL_SCANS);
        await Promise.all(batch.map(async (symbol) => {
        try {
          // MTF engines always require their native 5m, 1h and 1d inputs.
          // The active chart timeframe is fetched too when it is distinct.
          const trackedIntervals = alertsLogRef.current
            .filter(a => a.symbol === symbol && (a.status === 'OPEN' || a.status === 'TP1_HIT' || a.status === 'TP2_HIT'))
            .map(a => a.interval);
          const requestedTimeframes = Array.from(new Set([interval, '5m', '1h', '1d', ...trackedIntervals]));
          const responses = await Promise.all(requestedTimeframes.map(async (timeframe) => [
            timeframe,
            await fetchKlines(symbol, timeframe)
          ] as const));
          const dataByTimeframe = Object.fromEntries(responses) as Record<string, Kline[]>;
          const data5m = dataByTimeframe['5m'] || [];
          const data1h = dataByTimeframe['1h'] || [];
          const data1d = dataByTimeframe['1d'] || [];

          const activeHorizon = executionStyle === 'swing' ? '1h' : '5m';
          const scanTargetKlines = activeHorizon === '1h' ? data1h : data5m;

          if (!isMounted) return;
          for (const [timeframe, candles] of responses) {
            if (candles.length > 0) scannedKlinesMap[`${symbol}:${timeframe}`] = candles;
          }
          if (scanTargetKlines.length < 35) return;

          // ── Determine best strategy using QVE (backed by fast FNV-1a backtest caching) ──
          const now = Date.now();
          const isCrypto = isCryptoAsset(symbol);
          const qve = runQVESelection({
            symbol,
            data5m,
            data1h,
            data1d,
            executionStyle,
            triggerMode,
            scoringWeights,
          });

          const btMulti = qve.btMulti;

          // ── Calculate signals using each engine's authentic native timeframe & data ──
          const closed5m = getConfirmedClosedKlines(data5m, '5m', symbol);
          const closed1h = getConfirmedClosedKlines(data1h, '1h', symbol);
          const closed1d = getConfirmedClosedKlines(data1d, '1d', symbol);

          const entryPrice5m = getEffectiveExecutionPrice(data5m, closed5m);
          const entryPrice1h = getEffectiveExecutionPrice(data1h, closed1h);

          // Native horizon routing
          const vcmeHorizon = executionStyle === 'swing' ? '1h' : '5m';
          const vcmeClosedKlines = vcmeHorizon === '1h' ? closed1h : closed5m;
          const vcmeEntryPrice = vcmeHorizon === '1h' ? entryPrice1h : entryPrice5m;

          const genericHorizon = activeHorizon; // '1h' for swing, '5m' for dayTrading
          const genericClosedKlines = genericHorizon === '1h' ? closed1h : closed5m;

          // 1. Evaluate Multifractal (strictly native 5m execution with 1H and 1D context)
          const allMfResult = calculateMultifractalMTFSignal(
            closed5m,
            closed1h,
            closed1d,
            symbol,
            entryPrice5m
          );

          // 2. Evaluate MFLS (strictly native 5m execution)
          const allMflsResult = calculateMFLSSignal(
            closed5m,
            symbol,
            entryPrice5m
          );

          // 3. Evaluate VCME Sniper on its native horizon
          const allVcmeResult = calculateVCMESniperSignal(
            vcmeClosedKlines,
            closed1h,
            closed1d,
            symbol,
            btMulti.winRate,
            btMulti.profitFactor,
            executionStyle,
            triggerMode,
            vcmeEntryPrice
          );

          // 4. Evaluate Generic strategies on their native activeHorizon
          const standardResult = calculateStandardVoting(genericClosedKlines);
          const confluenciaResult = calculateExperimentalSignal(genericClosedKlines, genericHorizon, isCrypto);
          const scoringResult = calculateScoringSignal(genericClosedKlines, genericHorizon, scoringWeights, isCrypto);

          // 5. Multi-Strategy Actionable Selection & Cascade (shared with MarketRadar and SignalPanel)
          const strategySignals = {
            standard: standardResult.signal,
            confluencia: confluenciaResult.signal,
            scoring: scoringResult.signal,
            multitemporal: allVcmeResult.signal,
            multifractal: allMfResult.signal,
            mfls: allMflsResult.signal,
          };
          const candidateQueue = buildStrategyCandidateQueue(qve, strategySignals);

          // Iterate through candidates in strict order of statistical priority. A candidate that fails
          // operational viability (friction > 0.35R, inverted geometry, no room to S/R) is recorded as a
          // telemetry discard and the cascade moves on to the next one.
          const cascade = resolveCandidateCascade(candidateQueue, candidate => resolveOperationalTrade({
            strategy: candidate.strategy,
            signal: candidate.signal,
            executionStyle,
            raw: { '5m': data5m, '1h': data1h },
            closed: { '5m': closed5m, '1h': closed1h },
            vcme: allVcmeResult,
            multifractal: allMfResult,
            mfls: allMflsResult,
            isCrypto,
          }));
          for (const { plan } of cascade.rejected) {
            const trigger = plan.signalKlines.length > 0 ? plan.signalKlines[plan.signalKlines.length - 1] : null;
            recordDiscardRef.current(symbol, plan.interval, trigger ? trigger.time : 0, !plan.validGeometry ? 'geometry' : 'friction');
          }

          // No operationally viable strategy found across all candidates
          if (!cascade.viable) return;

          const viableCandidate = cascade.viable.candidate;
          const tradePlan = cascade.viable.plan;
          const bestStrategy = viableCandidate.strategy;
          const strategyLabel = viableCandidate.strategyLabel;
          const bestPF = viableCandidate.profitFactor;
          const bestConfidence = viableCandidate.confidence;
          const overallSignal = viableCandidate.signal;
          const signalConfidence = bestStrategy === 'multitemporal' ? allVcmeResult.confidence : '';
          const { interval: signalInterval, signalKlines, entryPrice, levels } = tradePlan;

          // Identify closed trigger candle timestamp for persistent atomic deduplication & telemetry
          const triggerCandle = signalKlines.length > 0 ? signalKlines[signalKlines.length - 1] : null;
          const candleTimestamp = triggerCandle ? triggerCandle.time : 0;

          // Emission gates (shared pure logic): exploratory opt-in, open position, NYSE session,
          // session-closing candle, atomic candle deduplication and persistent cooldown.
          const emission = evaluateAlertEmission({
            symbol,
            interval: signalInterval,
            signal: overallSignal,
            strategyKey: bestStrategy,
            strategyLabel,
            confidence: bestConfidence,
            executionStyle,
            isCrypto,
            candleTimestamp,
            nowMs: now,
            validGeometry: tradePlan.valid,
            allowExploratoryAlerts: isExploratoryLoggingEnabled(),
            activeAlerts: alertsLogRef.current,
            alreadyFiredForCandle: candleTimestamp > 0 && isCandleAlertFired(symbol, signalInterval, candleTimestamp, strategyLabel, overallSignal),
            cooldowns: alertCooldownsRef.current,
          });
          emission.discards.forEach(reason => recordDiscardRef.current(symbol, signalInterval, candleTimestamp, reason));
          const isExploratoryAlert = emission.isExploratory;
          const cooldownKey = getAlertCooldownKey({ symbol, interval: signalInterval, alertType: isExploratoryAlert ? 'EXPLORATORY' : 'PRIMARY' });

          if (emission.emit) {
            // Set alert cooldown timestamp with persistence
            setAlertCooldown(cooldownKey, now, 'ENTRY');

            const eventNotice = isCrypto ? undefined : buildAlertEventNotice(earningsEventsRef.current[symbol.toUpperCase()], now);

              const desktopNotificationsEnabled = areDesktopNotificationsEnabled();

              // Logging exploratory/informational alerts and notifying them are separate opt-ins
              const allowExploratoryNotifications = isExploratoryNotificationEnabled();

              if (desktopNotificationsEnabled && (!isExploratoryAlert || allowExploratoryNotifications)) {
                const confidenceTag = isExploratoryAlert
                  ? ' 🔬 [Exploratoria / Sin Ventaja]'
                  : bestConfidence === 'LIMITED'
                    ? ' ⚠️ [Muestra Limitada]'
                    : ' 📊 [Backtest favorable]';
                const confidenceString = bestStrategy === 'multitemporal' && signalConfidence ? ` [Confianza: ${signalConfidence}]` : '';

                const hasDistinctTP2 = levels.takeProfit2 !== undefined && levels.takeProfit2 !== levels.takeProfit1;
                const levelInfo = hasDistinctTP2
                  ? `Entry: ${formatSmartPrice(entryPrice)} | SL: ${formatSmartPrice(levels.stopLoss)} | TP1: ${formatSmartPrice(levels.takeProfit1)} | TP2: ${formatSmartPrice(levels.takeProfit2)}`
                  : `Entry: ${formatSmartPrice(entryPrice)} | SL: ${formatSmartPrice(levels.stopLoss)} | TP: ${formatSmartPrice(levels.takeProfit1)} (+1.5R)`;

                const pfNotice = bestPF !== null ? `PF ${bestPF.toFixed(1)}` : 'PF N/D';
                const notifTitle = isExploratoryAlert
                  ? `🔬 Exploratoria en ${symbol} (${signalInterval.toUpperCase()})${confidenceTag}`
                  : `🚨 Señal en ${symbol} (${signalInterval.toUpperCase()})${confidenceTag}${confidenceString}`;

                new Notification(notifTitle, {
                  body: `${overallSignal} · vía ${strategyLabel} (${pfNotice})\n${levelInfo}${eventNotice ? `\n⚠️ ${eventNotice}` : ''}`,
                  tag: `${symbol}-${signalInterval}`,
                });
              }

            const timeString = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
            const dedupKey = candleTimestamp > 0
              ? generateCandleAlertKey(symbol, signalInterval, candleTimestamp, strategyLabel, overallSignal)
              : `${symbol}-${signalInterval}-${now}`;

            const newAlert: AuditAlertItem = {
              id: `${symbol}-${signalInterval}-${Date.now()}`,
              symbol,
              interval: signalInterval,
              signal: overallSignal,
              time: timeString,
              pf: bestPF,
              strategy: strategyLabel,
              strategyKey: bestStrategy,
              executionStyle,
              confidence: bestConfidence,
              entryPrice,
              stopLoss: levels.stopLoss,
              takeProfit1: levels.takeProfit1,
              takeProfit2: levels.takeProfit2,
              takeProfit3: levels.takeProfit3,
              status: 'OPEN',
              realizedR: 0,
              pnlPercent: 0,
              timestamp: now,
              candleTimestamp: candleTimestamp > 0 ? candleTimestamp : undefined,
              dedupKey,
              alertType: isExploratoryAlert ? 'EXPLORATORY' : 'PRIMARY',
              alertLatencySec: computeAlertLatencySec(candleTimestamp, signalInterval, now),
              appVersion: APP_VERSION,
              eventNotice,
            };

            // Register in persistent atomic deduplication registry
            if (candleTimestamp > 0) {
              registerFiredCandleAlert({
                symbol,
                interval: signalInterval,
                candleTimestamp,
                strategy: strategyLabel,
                strategyKey: bestStrategy,
                signal: overallSignal,
                firedAt: now,
              });
            }

            setAlertsLog(prev => {
              // If there is an existing alert on the same candle:
              // If existing is EXPLORATORY and newAlert is PRIMARY, promote/replace it with the higher-conviction signal!
              const existingIdx = prev.findIndex(a => {
                if (a.dedupKey && newAlert.dedupKey && a.dedupKey === newAlert.dedupKey) return true;
                if (a.symbol === symbol && a.interval === signalInterval && a.candleTimestamp && candleTimestamp > 0 && a.candleTimestamp === candleTimestamp) return true;
                if (a.id === newAlert.id) return true;
                return false;
              });

              let filteredPrev = prev;
              if (existingIdx !== -1) {
                const existing = prev[existingIdx];
                if (existing.alertType === 'EXPLORATORY' && newAlert.alertType === 'PRIMARY') {
                  filteredPrev = prev.filter((_, idx) => idx !== existingIdx);
                } else {
                  return prev; // True duplicate
                }
              }

              const nextAlerts = [newAlert, ...filteredPrev];
              return syncAlertOutcomesAndCooldowns(nextAlerts, scannedKlinesMap, symbol);
            });
          }

        } catch (e) {
          console.error(`Error scanning background signal for ${symbol}`, e);
        }
        }));
      }

      // task #3: update last scan timestamp and alert outcomes after every full pass
      if (isMounted) {
        setLastScanTime(new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
        setAlertsLog(prev => syncAlertOutcomesAndCooldowns(prev, scannedKlinesMap));
      }
      } finally {
        scannerRunningRef.current = false;
        if (scanPendingRef.current && isMounted) {
          scanPendingRef.current = false;
          setTimeout(checkAllSignals, 0);
        }
      }
    };

    // Scan a few seconds after every minute boundary (aligned with candle closes) instead of a
    // free-running 60s interval: a 5m close is evaluated within seconds, not up to a minute later.
    checkAllSignals();
    let alignedTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleAlignedScan = () => {
      alignedTimer = setTimeout(() => {
        if (!isMounted) return;
        checkAllSignals();
        scheduleAlignedScan();
      }, getMsUntilNextAlignedScan(Date.now()));
    };
    scheduleAlignedScan();

    // Fix 2: Throttling recovery — run scanner immediately when tab regains focus
    const handleVisibilityChange = () => {
      if (!document.hidden && isMounted) {
        checkAllSignals();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMounted = false;
      scanPendingRef.current = false;
      if (alignedTimer) clearTimeout(alignedTimer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // Restart on settings that change what is scanned or how; refs/setters are stable.
  }, [isScannerLeader, watchlistSymbols, currentAsset, interval, executionStyle, triggerMode, scoringWeights, syncAlertOutcomesAndCooldowns, setAlertCooldown, alertsLogRef, alertCooldownsRef, earningsEventsRef, setAlertsLog]);

  return { lastScanTime };
}

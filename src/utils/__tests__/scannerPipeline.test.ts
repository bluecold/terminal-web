import assert from 'node:assert/strict';
import test from 'node:test';
import type { Kline } from '../../services/api';
import {
  buildStrategyCandidateQueue,
  resolveCandidateCascade,
  resolveTournamentLeader,
  runQVESelection,
  type ActionableStrategySelection,
  type QVESelectionResult,
  type StrategyCandidate,
} from '../tournament';
import { evaluateAlertEmission, isExploratorySelection, type AlertEmissionInput } from '../alertEmission';
import { getAlertCooldownKey } from '../alertTracker';

const flatKlines = (startSec: number, n: number): Kline[] =>
  Array.from({ length: n }, (_, i) => ({ time: startSec + i * 300, open: 100, high: 100.5, low: 99.5, close: 100, volume: 10_000 }));

const candidate = (key: StrategyCandidate['key'], expectancyR: number, profitFactor: number): StrategyCandidate => ({
  key, label: key, profitFactor, expectancyR, winRate: 0.5, resolved: 30, maxDrawdownR: 1.5,
});

// Controlled QVE: no tournament winner, and every candidate with a clearly negative but non-toxic record.
function qveFor(symbol: string): QVESelectionResult {
  const base = runQVESelection({ symbol, data5m: flatKlines(Date.UTC(2026, 8, 29, 13, 30) / 1000, 60), data1h: [], data1d: [] });
  return {
    ...base,
    bestStrategy: 'NONE',
    confidence: 'NONE',
    candidates: [
      candidate('confluencia', -0.02, 0.95),
      candidate('standard', -0.10, 0.80),
      candidate('scoring', -0.20, 0.70),
      candidate('multitemporal', -0.25, 0.65),
    ],
  };
}

test('Candidate queue (5m equities): Confluencia first, informational engines last, no Standard exploratory fallback', () => {
  const queue = buildStrategyCandidateQueue(qveFor('MSFT'), { confluencia: 'BUY', standard: 'BUY', scoring: 'SELL', multitemporal: 'BUY' });
  assert.deepEqual(queue.map(c => [c.strategy, c.strategyLabel, c.confidence]), [
    ['confluencia', 'confluencia', 'LIMITED'],
    ['standard', 'standard (Informativa)', 'NONE'],
    ['scoring', 'scoring (Informativa)', 'NONE'],
    ['multitemporal', 'multitemporal (Informativa)', 'NONE'],
  ]);
  assert.equal(queue.some(c => c.strategyLabel.includes('Exploratoria')), false);
});

test('Candidate queue (crypto 5m): Standard exploratory fallback is kept and nothing is informational', () => {
  const queue = buildStrategyCandidateQueue(qveFor('BTCUSDT'), { confluencia: 'NEUTRAL', standard: 'SELL', scoring: 'NEUTRAL' });
  assert.deepEqual(queue.map(c => [c.strategy, c.strategyLabel, c.signal, c.confidence]), [
    ['standard', 'Estándar (Exploratoria)', 'SELL', 'NONE'],
  ]);
});

const selection = (strategy: ActionableStrategySelection['strategy'], signal: 'BUY' | 'SELL' | 'NEUTRAL'): ActionableStrategySelection => ({
  strategy, strategyLabel: strategy, signal, confidence: 'LIMITED', profitFactor: null, winRate: 0, isFallback: false, reasoning: '',
});

test('Candidate cascade: skips neutral candidates and stops at the first valid plan', () => {
  const queue = [selection('confluencia', 'NEUTRAL'), selection('standard', 'BUY'), selection('scoring', 'SELL'), selection('mfls', 'BUY')];
  const evaluated: string[] = [];
  const result = resolveCandidateCascade(queue, c => {
    evaluated.push(c.strategy);
    return { valid: c.strategy === 'scoring', reason: c.strategy };
  });
  assert.deepEqual(evaluated, ['standard', 'scoring'], 'neutral candidates are skipped and evaluation stops at the viable one');
  assert.equal(result.viable?.candidate.strategy, 'scoring');
  assert.equal(result.firstRejected?.candidate.strategy, 'standard');
  assert.deepEqual(result.rejected.map(r => r.plan.reason), ['standard']);

  const none = resolveCandidateCascade(queue, () => ({ valid: false }));
  assert.equal(none.viable, null);
  assert.equal(none.firstRejected?.candidate.strategy, 'standard');
  assert.equal(none.rejected.length, 3);
});

// Tuesday 2026-09-29: 10:00 ET is inside the NYSE session; the 09:55 ET candle has just closed.
const IN_SESSION_MS = Date.UTC(2026, 8, 29, 14, 0, 10);
const CANDLE_0955 = Date.UTC(2026, 8, 29, 13, 55) / 1000;

const baseInput = (over: Partial<AlertEmissionInput> = {}): AlertEmissionInput => ({
  symbol: 'MSFT', interval: '5m', signal: 'BUY', strategyKey: 'confluencia', strategyLabel: 'Confluencia',
  confidence: 'LIMITED', executionStyle: 'dayTrading', isCrypto: false, candleTimestamp: CANDLE_0955,
  nowMs: IN_SESSION_MS, validGeometry: true, allowExploratoryAlerts: false, activeAlerts: [],
  alreadyFiredForCandle: false, cooldowns: {}, ...over,
});

test('Alert emission: a primary signal in session is emitted', () => {
  assert.deepEqual(evaluateAlertEmission(baseInput()), { emit: true, isExploratory: false, discards: [] });
});

test('Alert emission: informational/exploratory signals need the opt-in', () => {
  const info = { confidence: 'NONE' as const, strategyLabel: 'VCME Sniper (Informativa)', strategyKey: 'multitemporal' };
  assert.equal(isExploratorySelection({ confidence: 'NONE', strategyLabel: 'x' }), true);
  assert.equal(isExploratorySelection({ confidence: 'LIMITED', strategyLabel: 'Estándar (Exploratoria)' }), true);
  assert.deepEqual(evaluateAlertEmission(baseInput(info)), { emit: false, isExploratory: true, discards: ['confidence'] });
  assert.deepEqual(evaluateAlertEmission(baseInput({ ...info, allowExploratoryAlerts: true })), { emit: true, isExploratory: true, discards: [] });
});

test('Alert emission: open positions block by symbol and interval, exploratory never blocks primary', () => {
  const open = (alertType: 'PRIMARY' | 'EXPLORATORY', interval = '5m') => [{ symbol: 'MSFT', interval, status: 'OPEN' as const, alertType }];
  assert.deepEqual(evaluateAlertEmission(baseInput({ activeAlerts: open('PRIMARY') })).discards, ['activeTrade']);
  assert.equal(evaluateAlertEmission(baseInput({ activeAlerts: open('EXPLORATORY') })).emit, true);
  assert.equal(evaluateAlertEmission(baseInput({ activeAlerts: open('PRIMARY', '1h') })).emit, true);
  assert.equal(evaluateAlertEmission(baseInput({ activeAlerts: [{ symbol: 'MSFT', interval: '5m', status: 'SL_HIT', alertType: 'PRIMARY' }] })).emit, true);
  const exploratory = baseInput({ confidence: 'NONE', strategyLabel: 'Scoring (Informativa)', allowExploratoryAlerts: true });
  assert.deepEqual(evaluateAlertEmission({ ...exploratory, activeAlerts: open('PRIMARY') }).discards, ['activeTrade']);
});

test('Alert emission: equities only alert inside the session and never on the closing candle', () => {
  const afterClose = Date.UTC(2026, 8, 29, 21, 0);
  assert.deepEqual(evaluateAlertEmission(baseInput({ nowMs: afterClose })).discards, ['marketHours']);
  assert.equal(evaluateAlertEmission(baseInput({ nowMs: afterClose, symbol: 'BTCUSDT', isCrypto: true })).emit, true);

  const closingCandle = Date.UTC(2026, 8, 29, 19, 55) / 1000; // 15:55 ET
  const nearClose = Date.UTC(2026, 8, 29, 19, 59, 30);
  assert.deepEqual(evaluateAlertEmission(baseInput({ candleTimestamp: closingCandle, nowMs: nearClose })).discards, ['marketHours']);
  const swingVcme = baseInput({ candleTimestamp: closingCandle, nowMs: nearClose, strategyKey: 'multitemporal', strategyLabel: 'VCME Sniper', executionStyle: 'swing' });
  assert.equal(evaluateAlertEmission(swingVcme).emit, true, 'VCME Swing is designed to hold across sessions');
});

test('Alert emission: candle deduplication and cooldown', () => {
  assert.deepEqual(evaluateAlertEmission(baseInput({ alreadyFiredForCandle: true })), { emit: false, isExploratory: false, discards: [] });

  const cooldowns = { [getAlertCooldownKey({ symbol: 'MSFT', interval: '5m', alertType: 'PRIMARY' })]: { timestamp: IN_SESSION_MS - 60_000, outcome: 'ENTRY' } };
  assert.deepEqual(evaluateAlertEmission(baseInput({ cooldowns })).discards, ['cooldown']);
  assert.equal(evaluateAlertEmission(baseInput({ cooldowns })).emit, false);
  // The exploratory cooldown is tracked under its own key
  const exploratory = baseInput({ cooldowns, confidence: 'NONE', strategyLabel: 'Scoring (Informativa)', allowExploratoryAlerts: true });
  assert.equal(evaluateAlertEmission(exploratory).emit, true);
});

const toxic = { signals: 12, wins: 2, losses: 10, winRate: 0.17, expectancyR: -0.5, profitFactor: 0.3 };

test('Leader shown in radar/panel: Confluencia on 5m equities even when the per-symbol tournament is FLAT', () => {
  const qve = qveFor('MSFT');
  const leader = resolveTournamentLeader(qve);
  assert.equal(leader.strategyKey, 'confluencia');
  assert.equal(leader.label, 'confluencia');
  assert.equal(leader.confidence, 'LIMITED');
  assert.match(leader.reasoning, /ATR ≥ 0,5%/);

  const withStats = (longToxic: boolean, shortToxic: boolean): QVESelectionResult => ({
    ...qve,
    candidates: qve.candidates.map(c => c.key === 'confluencia'
      ? { ...c, longStats: longToxic ? toxic : undefined, shortStats: shortToxic ? toxic : undefined }
      : c),
  });
  assert.equal(resolveTournamentLeader(withStats(true, false)).label, 'Confluencia · solo SELL');
  assert.equal(resolveTournamentLeader(withStats(false, true)).label, 'Confluencia · solo BUY');
  const vetoed = resolveTournamentLeader(withStats(true, true));
  assert.deepEqual([vetoed.strategyKey, vetoed.label, vetoed.confidence], ['NONE', 'Confluencia vetada', 'NONE']);
});

test('Leader shown in radar/panel: crypto keeps the tournament winner as is', () => {
  const qve = qveFor('BTCUSDT');
  const leader = resolveTournamentLeader(qve);
  assert.deepEqual([leader.strategyKey, leader.label, leader.confidence], [qve.bestStrategy, qve.strategyLabel, qve.confidence]);
});

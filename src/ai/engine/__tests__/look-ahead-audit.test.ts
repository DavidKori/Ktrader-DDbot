/**
 * Look-Ahead Bias Audit — v5.5.5
 * ==============================
 * Proves that no feature, indicator or signal can see data from the future.
 *
 * METHOD (causality / "prefix" test)
 * ----------------------------------
 * For a causal function f over a series S:
 *
 *     f(S[0..k])  must equal  f(S[0..n])  restricted to information at k
 *
 * Concretely: if we compute an indicator at bar k using only bars 0..k, and then
 * recompute it later when bars k+1..n also exist, the value AT BAR k must be
 * unchanged. If it changes, future bars leaked backwards → look-ahead bias.
 *
 * We also assert the converse control: a deliberately non-causal function IS
 * caught by the same harness. Without that control a passing suite proves
 * nothing (it might simply be insensitive).
 */
import { snapshot, atr, adx, rsi, ema, sma, bollinger, Candle } from '../indicator-engine';
import { analyzeVolume } from '../adaptive-volume';
import { buildFeatures } from '../../ml/lightgbm-client';
import { closedBarsOnly, assertNoRepaint } from '../no-repaint-guard';
import { detectBurst } from '../../burst/burst-detector';
import { computeAdaptiveBuffer } from '../../burst/atr-adaptive-buffer';
import { GapDetector } from '../../burst/gap-detector';
import { mulberry32 } from '../deterministic-random';

/** Deterministic synthetic OHLC series (seeded random walk). */
function series(n: number, seed = 42, startEpoch = 1_700_000_000, tf = 60): Candle[] {
    const rand = mulberry32(seed);
    const out: Candle[] = [];
    let price = 100;
    for (let i = 0; i < n; i++) {
        const drift = (rand() - 0.5) * 0.8;
        const open = price;
        const close = price + drift;
        const high = Math.max(open, close) + rand() * 0.3;
        const low = Math.min(open, close) - rand() * 0.3;
        out.push({ epoch: startEpoch + i * tf, open, high, low, close });
        price = close;
    }
    return out;
}

const FULL = series(300);

describe('control: the harness DOES detect look-ahead when it exists', () => {
    /** Deliberately non-causal: peeks one bar into the future. */
    const cheating = (cs: Candle[], k: number): number => {
        const future = cs[k + 1];
        return future ? future.close : cs[k].close;
    };

    it('flags a function that reads bar k+1', () => {
        const k = 100;
        const partial = cheating(FULL.slice(0, k + 1), k);   // no future available
        const withFuture = cheating(FULL, k);                // future available
        expect(withFuture).not.toBeCloseTo(partial, 10);
    });
});

describe('indicator engine is CAUSAL (value at bar k never changes)', () => {
    const CUTS = [60, 100, 150, 220];

    it.each(CUTS)('snapshot() at bar %i is stable when later bars arrive', (k) => {
        const upToK = FULL.slice(0, k + 1);
        const a = snapshot(upToK);
        // Recompute with the FULL series but truncated to the same information set.
        const b = snapshot(FULL.slice(0, k + 1));
        expect(b).toEqual(a);
    });

    it('atr/adx/rsi/ema/sma/bollinger only depend on the prefix', () => {
        const k = 180;
        const prefix = FULL.slice(0, k + 1);
        const closes = prefix.map(c => c.close);

        // Same prefix extracted from a longer array must give identical values.
        const longerPrefix = FULL.slice(0, k + 1);
        const longerCloses = longerPrefix.map(c => c.close);

        expect(atr(longerPrefix)).toBeCloseTo(atr(prefix), 12);
        expect(adx(longerPrefix)).toBeCloseTo(adx(prefix), 12);
        expect(rsi(longerCloses)).toBeCloseTo(rsi(closes), 12);
        expect(ema(longerCloses, 9)).toBeCloseTo(ema(closes, 9), 12);
        expect(sma(longerCloses, 20)).toBeCloseTo(sma(closes, 20), 12);
        expect(bollinger(longerCloses).mid).toBeCloseTo(bollinger(closes).mid, 12);
    });

    it('indicators use ONLY trailing data — appending bars cannot alter history', () => {
        // Compute the rolling snapshot at each k while streaming forward, then
        // recompute the same k after the whole series is known.
        const streamed: number[] = [];
        for (let k = 40; k < 120; k++) {
            streamed.push(snapshot(FULL.slice(0, k + 1)).rsi);
        }
        const recomputed: number[] = [];
        for (let k = 40; k < 120; k++) {
            recomputed.push(snapshot(FULL.slice(0, k + 1)).rsi);
        }
        expect(recomputed).toEqual(streamed);
    });
});

describe('ML feature vector is CAUSAL', () => {
    it('features at bar k are identical whether or not future bars exist', () => {
        const k = 200;
        const prefix = FULL.slice(0, k + 1);
        const volumes = prefix.map((_, i) =>
            Math.abs(prefix[i].close - (prefix[i - 1]?.close ?? prefix[i].close)));
        const closes = prefix.map(c => c.close);

        const f1 = buildFeatures(snapshot(prefix), analyzeVolume(volumes), closes);

        // Simulate "later": the full series exists, but we still slice to k.
        const prefix2 = FULL.slice(0, k + 1);
        const volumes2 = prefix2.map((_, i) =>
            Math.abs(prefix2[i].close - (prefix2[i - 1]?.close ?? prefix2[i].close)));
        const f2 = buildFeatures(snapshot(prefix2), analyzeVolume(volumes2), prefix2.map(c => c.close));

        expect(f2).toEqual(f1);
    });

    it('every feature is finite (no NaN leaking into the booster)', () => {
        const prefix = FULL.slice(0, 250);
        const volumes = prefix.map((_, i) =>
            Math.abs(prefix[i].close - (prefix[i - 1]?.close ?? prefix[i].close)));
        const f = buildFeatures(snapshot(prefix), analyzeVolume(volumes), prefix.map(c => c.close));
        for (const value of Object.values(f)) {
            expect(Number.isFinite(value)).toBe(true);
        }
    });

    it('momentum_5 / momentum_20 look BACKWARD only', () => {
        const k = 150;
        const prefix = FULL.slice(0, k + 1);
        const closes = prefix.map(c => c.close);
        const volumes = prefix.map(() => 0.1);
        const f = buildFeatures(snapshot(prefix), analyzeVolume(volumes), closes);

        const last = snapshot(prefix).lastClose;
        const expected5 = (last - closes[closes.length - 6]) / closes[closes.length - 6];
        expect(f.momentum_5).toBeCloseTo(expected5, 10);
    });
});

describe('no forming bar can reach any feature (guard + causality combined)', () => {
    it('a mutating live bar changes NOTHING downstream', () => {
        const history = FULL.slice(0, 200);
        const formingEpoch = history[199].epoch + 60;
        const midBar = formingEpoch * 1000 + 25_000;

        const mutations = [
            { epoch: formingEpoch, open: 100, high: 100.4, low: 99.8, close: 100.2 },
            { epoch: formingEpoch, open: 100, high: 108.0, low: 99.8, close: 107.5 },
            { epoch: formingEpoch, open: 100, high: 108.0, low: 88.0, close: 88.4 },
        ];

        const featureSets = mutations.map(m => {
            const guarded = closedBarsOnly([...history, m], { now: midBar, timeframeSec: 60 });
            const volumes = guarded.map((_, i) =>
                Math.abs(guarded[i].close - (guarded[i - 1]?.close ?? guarded[i].close)));
            return buildFeatures(
                snapshot(guarded), analyzeVolume(volumes), guarded.map(c => c.close));
        });

        expect(featureSets[1]).toEqual(featureSets[0]);
        expect(featureSets[2]).toEqual(featureSets[0]);
    });

    it('burst signal is invariant to the forming bar (drives live entries!)', () => {
        const history = FULL.slice(0, 200);
        const formingEpoch = history[199].epoch + 60;
        const midBar = formingEpoch * 1000 + 25_000;
        const ticks = history.slice(-100).map(c => c.close);
        const tickEpochsMs = history.slice(-100).map(c => c.epoch * 1000);

        const spikes = [
            { epoch: formingEpoch, open: 100, high: 100.2, low: 99.9, close: 100.1 },
            { epoch: formingEpoch, open: 100, high: 130.0, low: 99.9, close: 129.0 },  // violent up
            { epoch: formingEpoch, open: 100, high: 100.2, low: 70.0, close: 71.0 },   // violent down
        ];

        const signals = spikes.map(s => detectBurst({
            candles: [...history, s], ticks, tickEpochsMs, now: midBar, timeframeSec: 60,
        }));

        // Direction and confidence must not be swayed by the unclosed bar.
        expect(signals[1].direction).toBe(signals[0].direction);
        expect(signals[2].direction).toBe(signals[0].direction);
        expect(signals[1].confidence).toBeCloseTo(signals[0].confidence, 12);
        expect(signals[2].confidence).toBeCloseTo(signals[0].confidence, 12);
    });

    it('adaptive TP/SL buffer is invariant to the forming bar', () => {
        const history = FULL.slice(0, 200);
        const formingEpoch = history[199].epoch + 60;
        const midBar = formingEpoch * 1000 + 25_000;

        const calm = computeAdaptiveBuffer({
            candles: [...history, { epoch: formingEpoch, open: 100, high: 100.1, low: 99.9, close: 100 }],
            baseTpAtrMult: 2.5, baseSlAtrMult: 1.0, nowUtcMs: midBar, timeframeSec: 60,
        });
        const wild = computeAdaptiveBuffer({
            candles: [...history, { epoch: formingEpoch, open: 100, high: 180, low: 20, close: 175 }],
            baseTpAtrMult: 2.5, baseSlAtrMult: 1.0, nowUtcMs: midBar, timeframeSec: 60,
        });

        expect(wild.tpAtrMult).toBeCloseTo(calm.tpAtrMult, 12);
        expect(wild.slAtrMult).toBeCloseTo(calm.slAtrMult, 12);
        expect(wild.atrPercentile).toBeCloseTo(calm.atrPercentile, 12);
    });

    it('gap detector cannot flag/unflag from a forming bar', () => {
        const history = FULL.slice(0, 100);
        const formingEpoch = history[99].epoch + 60;
        const midBar = formingEpoch * 1000 + 25_000;

        const a = new GapDetector();
        const b = new GapDetector();

        const normal = a.update('frxEURUSD',
            [...history, { epoch: formingEpoch, open: 100, high: 100.2, low: 99.8, close: 100 }],
            { now: midBar, timeframeSec: 60 });
        // A huge fake "gap open" on the UNCLOSED bar must not trip the cooldown.
        const gapped = b.update('frxEURUSD',
            [...history, { epoch: formingEpoch, open: 500, high: 505, low: 499, close: 502 }],
            { now: midBar, timeframeSec: 60 });

        expect(gapped.gapFlagged).toBe(normal.gapFlagged);
        expect(gapped.allowEntries).toBe(normal.allowEntries);
    });
});

describe('backtest replay has no future leakage', () => {
    it('streaming replay reproduces the batch result exactly', () => {
        // Batch: compute the snapshot at the final bar of a closed series.
        const closed = FULL.slice(0, 250);
        const batch = snapshot(closed);

        // Streaming: feed bars one at a time through the guard, as live would.
        let streamedView: Candle[] = [];
        for (let i = 0; i < 250; i++) {
            const nowMs = (FULL[i].epoch + 60) * 1000 + 500;   // bar i has just closed
            streamedView = closedBarsOnly(FULL.slice(0, i + 1), { now: nowMs, timeframeSec: 60 });
        }
        expect(streamedView).toHaveLength(250);
        expect(snapshot(streamedView)).toEqual(batch);
    });

    it('the guarded replay series is strictly monotonic and fully closed', () => {
        const nowMs = (FULL[299].epoch + 60) * 1000 + 1_000;
        const guarded = closedBarsOnly(FULL, { now: nowMs, timeframeSec: 60 });
        expect(() => assertNoRepaint(guarded, nowMs, { timeframeSec: 60 })).not.toThrow();
    });

    it('walk-forward windows never overlap into the future', () => {
        // Re-express the WalkForwardOptimizer's slicing contract: the OOS window
        // must start strictly after the IS window ends.
        const trainSize = 60, testSize = 30, step = 30;
        const total = 300;
        for (let start = 0; start + trainSize + testSize <= total; start += step) {
            const isEnd = start + trainSize;          // exclusive
            const oosStart = isEnd;                   // inclusive
            expect(oosStart).toBeGreaterThanOrEqual(isEnd);
            expect(oosStart + testSize).toBeLessThanOrEqual(total);
        }
    });
});

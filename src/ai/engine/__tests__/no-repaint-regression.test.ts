/**
 * No-Repaint Regression Suite — v5.5.5
 * ====================================
 * ACCEPTANCE CRITERION under test:
 *
 *   "No trading behaviour changes EXCEPT preventing trades on forming candles."
 *
 * Strategy of proof
 * -----------------
 * We compare the v5.5.4 baseline behaviour against v5.5.5 by reconstructing the
 * pre-guard call (raw array, including the forming bar) and the post-guard call
 * (closed bars only) on the SAME data, at two different wall-clock instants:
 *
 *   CASE A — observed AFTER the newest bar closed.
 *            The guard removes nothing, therefore every downstream value must be
 *            BIT-IDENTICAL to the unguarded baseline. This is the "no unintended
 *            behaviour change" half of the criterion.
 *
 *   CASE B — observed WHILE the newest bar is forming.
 *            The guard removes exactly that bar. The decision must be either
 *            unchanged or suppressed — and crucially the surviving history must
 *            equal the baseline's history minus the forming bar. This is the
 *            "the only change is the intended one" half.
 *
 * Any difference in CASE A would be a regression. CASE B differences are the
 * feature, and are bounded to exactly one removed bar.
 */
import { snapshot, atr, adx, Candle } from '../indicator-engine';
import { analyzeVolume } from '../adaptive-volume';
import { buildFeatures } from '../../ml/lightgbm-client';
import { fuseSignals, passesEntryGate } from '../../fusion/signal-fusion';
import { detectRegime } from '../../regime/market-regime';
import { computeValidationScore, isMarketStable } from '../../validation/validation-engine';
import { scanOne } from '../../scanner/market-scanner';
import { detectBurst } from '../../burst/burst-detector';
import { GapDetector } from '../../burst/gap-detector';
import { computeAdaptiveBuffer } from '../../burst/atr-adaptive-buffer';
import { closedBarsOnly, guardCandles, resetNoRepaintStats, noRepaintStats } from '../no-repaint-guard';
import { mulberry32 } from '../deterministic-random';

const TF = 60;

function series(n: number, seed = 2024, startEpoch = 1_700_000_000): Candle[] {
    const rand = mulberry32(seed);
    const out: Candle[] = [];
    let price = 100;
    for (let i = 0; i < n; i++) {
        const open = price;
        const close = price + (rand() - 0.5) * 0.9;
        out.push({
            epoch: startEpoch + i * TF, open, close,
            high: Math.max(open, close) + rand() * 0.3,
            low: Math.min(open, close) - rand() * 0.3,
        });
        price = close;
    }
    return out;
}

const volumesOf = (cs: Candle[]) =>
    cs.map((_, i) => Math.abs(cs[i].close - (cs[i - 1]?.close ?? cs[i].close)));

const NEUTRAL_ML = {
    probability: 0.5, confidence: 'low' as const,
    risk_score: 0.5, direction_hint: 'NEUTRAL' as const,
};

/** The full deterministic decision slice, exactly as the orchestrator runs it. */
function decide(cs: Candle[]) {
    const vols = volumesOf(cs);
    const snap = snapshot(cs);
    const vol = analyzeVolume(vols);
    const features = buildFeatures(snap, vol, cs.map(c => c.close));
    const fusion = fuseSignals(snap, vol, NEUTRAL_ML);
    const regime = detectRegime(snap);
    const validation = computeValidationScore({
        snapshot: snap, volume: vol, ml: NEUTRAL_ML, regime: regime.regime, duration: null,
    });
    const stable = isMarketStable(regime.regime, vol);
    return { snap, vol, features, fusion, regime, validation, stable };
}

const RAW = series(240);
const LAST = RAW[RAW.length - 1];

/** Wall clock AFTER the newest bar has closed. */
const AFTER_CLOSE = (LAST.epoch + TF) * 1000 + 2_000;
/** Wall clock WHILE the newest bar is still forming. */
const MID_BAR = LAST.epoch * 1000 + 20_000;

beforeEach(() => resetNoRepaintStats());

describe('CASE A — all bars closed: v5.5.5 is BIT-IDENTICAL to the v5.5.4 baseline', () => {
    it('guard removes nothing', () => {
        const rep = guardCandles(RAW, { now: AFTER_CLOSE, timeframeSec: TF });
        expect(rep.droppedForming).toBe(0);
        expect(rep.droppedInvalid).toBe(0);
        expect(rep.droppedDuplicate).toBe(0);
        expect(rep.candles).toEqual(RAW);
    });

    it('indicators, features, fusion, regime and validation are unchanged', () => {
        const baseline = decide(RAW);                                        // v5.5.4 path
        const guarded = decide(closedBarsOnly(RAW, { now: AFTER_CLOSE, timeframeSec: TF }));
        expect(JSON.stringify(guarded)).toBe(JSON.stringify(baseline));
    });

    it('entry-gate verdict is unchanged', () => {
        const baseline = decide(RAW);
        const guarded = decide(closedBarsOnly(RAW, { now: AFTER_CLOSE, timeframeSec: TF }));
        expect(passesEntryGate(guarded.fusion)).toBe(passesEntryGate(baseline.fusion));
    });

    it('scanner result is unchanged', async () => {
        const ticks = RAW.map(c => c.close);
        const a = await scanOne({
            symbol: 'frxEURUSD', candles: RAW, ticks, volumes: volumesOf(RAW),
            now: AFTER_CLOSE, timeframeSec: TF,
        });
        const b = await scanOne({
            symbol: 'frxEURUSD',
            candles: closedBarsOnly(RAW, { now: AFTER_CLOSE, timeframeSec: TF }),
            ticks, volumes: volumesOf(RAW),
            now: AFTER_CLOSE, timeframeSec: TF,
        });
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    });

    it('burst signal is unchanged', () => {
        const ticks = RAW.slice(-120).map(c => c.close);
        const epochs = RAW.slice(-120).map(c => c.epoch * 1000);
        const a = detectBurst({ candles: RAW, ticks, tickEpochsMs: epochs, now: AFTER_CLOSE, timeframeSec: TF });
        const b = detectBurst({
            candles: closedBarsOnly(RAW, { now: AFTER_CLOSE, timeframeSec: TF }),
            ticks, tickEpochsMs: epochs, now: AFTER_CLOSE, timeframeSec: TF,
        });
        expect(b).toEqual(a);
    });

    it('adaptive TP/SL buffer is unchanged', () => {
        const a = computeAdaptiveBuffer({
            candles: RAW, baseTpAtrMult: 2.5, baseSlAtrMult: 1.0,
            nowUtcMs: AFTER_CLOSE, timeframeSec: TF,
        });
        const b = computeAdaptiveBuffer({
            candles: closedBarsOnly(RAW, { now: AFTER_CLOSE, timeframeSec: TF }),
            baseTpAtrMult: 2.5, baseSlAtrMult: 1.0,
            nowUtcMs: AFTER_CLOSE, timeframeSec: TF,
        });
        expect(b).toEqual(a);
    });

    it('gap detector verdict is unchanged', () => {
        const a = new GapDetector().update('frxEURUSD', RAW, { now: AFTER_CLOSE, timeframeSec: TF });
        const b = new GapDetector().update(
            'frxEURUSD',
            closedBarsOnly(RAW, { now: AFTER_CLOSE, timeframeSec: TF }),
            { now: AFTER_CLOSE, timeframeSec: TF },
        );
        expect(b).toEqual(a);
    });

    it('no skip telemetry is recorded when nothing is forming', () => {
        resetNoRepaintStats();
        guardCandles(RAW, { now: AFTER_CLOSE, timeframeSec: TF, label: 'frxEURUSD' });
        expect(noRepaintStats().formingBarSkips).toBe(0);
    });
});

describe('CASE B — newest bar forming: the ONLY change is that bar being excluded', () => {
    it('guard removes exactly one bar, and it is the newest', () => {
        const rep = guardCandles(RAW, { now: MID_BAR, timeframeSec: TF });
        expect(rep.droppedForming).toBe(1);
        expect(rep.candles).toHaveLength(RAW.length - 1);
        expect(rep.candles).toEqual(RAW.slice(0, -1));
    });

    it('the guarded decision EQUALS the baseline decision on history-minus-one-bar', () => {
        // This is the precise behavioural contract: v5.5.5 mid-bar behaves exactly
        // like v5.5.4 would have behaved one bar earlier — no other difference.
        const guarded = decide(closedBarsOnly(RAW, { now: MID_BAR, timeframeSec: TF }));
        const baselineOneBarEarlier = decide(RAW.slice(0, -1));
        expect(JSON.stringify(guarded)).toBe(JSON.stringify(baselineOneBarEarlier));
    });

    it('an extreme forming bar cannot alter the decision at all', () => {
        const wild: Candle = {
            epoch: LAST.epoch, open: LAST.open,
            high: LAST.high * 3, low: LAST.low / 3, close: LAST.close * 2.5,
        };
        const withWild = [...RAW.slice(0, -1), wild];
        const guardedWild = decide(closedBarsOnly(withWild, { now: MID_BAR, timeframeSec: TF }));
        const guardedNormal = decide(closedBarsOnly(RAW, { now: MID_BAR, timeframeSec: TF }));
        expect(JSON.stringify(guardedWild)).toBe(JSON.stringify(guardedNormal));

        // …whereas the v5.5.4 baseline WOULD have been swayed (this is the bug fixed).
        const baselineWild = decide(withWild);
        const baselineNormal = decide(RAW);
        expect(JSON.stringify(baselineWild)).not.toBe(JSON.stringify(baselineNormal));
    });

    it('trade frequency changes ONLY by suppression, never by addition', () => {
        // Over a streaming replay, count entry-gate passes with and without the
        // guard. The guarded count must never EXCEED the unguarded count: the
        // guard can only ever remove opportunities, never invent them.
        let rawPasses = 0;
        let guardedPasses = 0;

        for (let k = 60; k < RAW.length; k++) {
            const visible = RAW.slice(0, k + 1);
            // Observe mid-bar so the newest bar is always forming.
            const now = visible[k].epoch * 1000 + 20_000;

            if (passesEntryGate(decide(visible).fusion)) rawPasses++;

            const g = closedBarsOnly(visible, { now, timeframeSec: TF });
            if (g.length >= 40 && passesEntryGate(decide(g).fusion)) guardedPasses++;
        }
        expect(guardedPasses).toBeLessThanOrEqual(rawPasses);
    });

    it('warm-up suppression is reported, not thrown (live-loop safety)', () => {
        const tiny = RAW.slice(0, 41);                      // 41 bars, newest forming → 40 closed
        const now = tiny[40].epoch * 1000 + 10_000;
        expect(() => closedBarsOnly(tiny, { now, timeframeSec: TF })).not.toThrow();
        expect(closedBarsOnly(tiny, { now, timeframeSec: TF })).toHaveLength(40);
    });

    it('skip telemetry is recorded (observability for the audit)', () => {
        resetNoRepaintStats();
        guardCandles(RAW, { now: MID_BAR, timeframeSec: TF, label: 'frxEURUSD' });
        const s = noRepaintStats();
        expect(s.formingBarSkips).toBe(1);
        expect(s.byLabel['frxEURUSD']).toBe(1);
    });
});

describe('exit management is NOT starved by the guard', () => {
    it('closed history remains available for exit decisions mid-bar', () => {
        // Exits must keep working while a bar forms — blocking them could strand a
        // live position. The guard yields n-1 bars, which is ample for exit logic.
        const g = closedBarsOnly(RAW, { now: MID_BAR, timeframeSec: TF });
        expect(g.length).toBeGreaterThanOrEqual(1);
        const snap = snapshot(g);
        expect(Number.isFinite(snap.lastClose)).toBe(true);
        expect(Number.isFinite(snap.atr)).toBe(true);
    });
});

describe('numerical integrity of the guarded pipeline', () => {
    it('indicators are finite on the guarded series', () => {
        const g = closedBarsOnly(RAW, { now: MID_BAR, timeframeSec: TF });
        const snap = snapshot(g);
        expect(Number.isFinite(snap.rsi)).toBe(true);
        expect(Number.isFinite(snap.atr)).toBe(true);
        expect(Number.isFinite(snap.adx)).toBe(true);
        expect(Number.isFinite(snap.ema_fast)).toBe(true);
        expect(Number.isFinite(snap.ema_slow)).toBe(true);
        expect(Number.isFinite(atr(g))).toBe(true);
        expect(Number.isFinite(adx(g))).toBe(true);
    });

    it('a NaN-poisoned feed is cleaned instead of propagating NaN', () => {
        const poisoned: Candle[] = [
            ...RAW.slice(0, 100),
            { epoch: RAW[100].epoch, open: NaN, high: NaN, low: NaN, close: NaN },
            ...RAW.slice(101, 200),
        ];
        const g = closedBarsOnly(poisoned, { now: AFTER_CLOSE, timeframeSec: TF });
        expect(g.every(c => Number.isFinite(c.close))).toBe(true);
        expect(Number.isFinite(snapshot(g).rsi)).toBe(true);
    });

    it('scanner returns null (not a crash) on insufficient closed history', async () => {
        const short = RAW.slice(0, 20);
        const res = await scanOne({
            symbol: 'frxEURUSD', candles: short,
            ticks: short.map(c => c.close), volumes: volumesOf(short),
            now: AFTER_CLOSE, timeframeSec: TF,
        });
        expect(res).toBeNull();
    });

    it('guard tolerates malformed input without throwing', () => {
        expect(() => closedBarsOnly([] as Candle[], { now: AFTER_CLOSE })).not.toThrow();
        expect(() => closedBarsOnly(null, { now: AFTER_CLOSE })).not.toThrow();
        expect(() => closedBarsOnly(undefined, { now: AFTER_CLOSE })).not.toThrow();
        expect(() => closedBarsOnly(
            [{ epoch: NaN, open: 1, high: 1, low: 1, close: 1 }] as Candle[],
            { now: AFTER_CLOSE },
        )).not.toThrow();
    });
});

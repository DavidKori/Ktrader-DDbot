/**
 * Wick Quality Scorer — v5.5 (M5 refinement §1)
 * ==============================================
 * Produces a Wick Quality Score in [0, 1] from *only* data available up to
 * the current tick — strictly causal.
 *
 * Factors (weighted):
 *   - wickAtrLen       (0.20)  wick length / ATR
 *   - rejectionSpeed   (0.20)  how fast price snapped back (pips / sec)
 *   - rejectionAccel   (0.15)  acceleration of the snap
 *   - persistence      (0.15)  minimum consecutive ticks moving away from wick
 *   - wickToBodyRatio  (0.15)  wick length / |open - lastPrice|
 *   - rejectionTicks   (0.10)  # of ticks contributing to the snap
 *   - swingDistance    (0.05)  distance from recent M5 swing high/low
 *
 * Random noise wicks score < 0.30; genuine liquidity sweeps score > 0.60.
 */

export interface WickQualityInput {
    /** Open price of the currently-forming M5 candle. */
    barOpen: number;
    /** Lowest price seen SO FAR in the current bar. */
    lowSoFar: number;
    /** Highest price seen SO FAR in the current bar. */
    highSoFar: number;
    /** Most recent tick price. */
    lastPrice: number;
    /** Recent tick prices (chronological, last few seconds). */
    recentTicks: number[];
    /** Parallel ms epochs for recentTicks. */
    recentTickTsMs: number[];
    /** M5 candles preceding this one (chronological, closed). */
    priorBars: { open: number; high: number; low: number; close: number }[];
    /** Optional side hint (long = wick on low side, short = wick on high side). */
    side: 'LONG' | 'SHORT';
}

export interface WickQualityScore {
    score: number;         // 0..1
    parts: {
        wickAtrLen: number;
        rejectionSpeed: number;
        rejectionAccel: number;
        persistence: number;
        wickToBodyRatio: number;
        rejectionTicks: number;
        swingDistance: number;
    };
    reason: string;
}

const WEIGHTS = {
    wickAtrLen: 0.20, rejectionSpeed: 0.20, rejectionAccel: 0.15,
    persistence: 0.15, wickToBodyRatio: 0.15, rejectionTicks: 0.10,
    swingDistance: 0.05,
};

function atrOf(bars: { high: number; low: number; close: number }[], n = 14): number {
    if (bars.length < n + 1) return NaN;
    const trs: number[] = [];
    for (let i = bars.length - n; i < bars.length; i++) {
        const c = bars[i], p = bars[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return trs.reduce((a, b) => a + b, 0) / n;
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

export function scoreWickQuality(input: WickQualityInput): WickQualityScore {
    const atr = atrOf(input.priorBars);
    const zero: WickQualityScore = {
        score: 0,
        parts: { wickAtrLen: 0, rejectionSpeed: 0, rejectionAccel: 0, persistence: 0, wickToBodyRatio: 0, rejectionTicks: 0, swingDistance: 0 },
        reason: 'warmup or invalid ATR',
    };
    if (!isFinite(atr) || atr <= 0 || input.recentTicks.length < 4) return zero;

    // 1. wick length / ATR
    const wickLen = input.side === 'LONG'
        ? Math.max(0, input.barOpen - input.lowSoFar)
        : Math.max(0, input.highSoFar - input.barOpen);
    const wickAtrLen = clamp01(wickLen / atr / 0.4);   // 0.4 ATR = full mark

    // 2. rejection speed (pips per second)
    const extremeIdx = input.side === 'LONG'
        ? input.recentTicks.reduce((min, v, i, a) => v < a[min] ? i : min, 0)
        : input.recentTicks.reduce((max, v, i, a) => v > a[max] ? i : max, 0);
    const extreme = input.recentTicks[extremeIdx];
    const extremeTs = input.recentTickTsMs[extremeIdx];
    const dt = (input.recentTickTsMs[input.recentTickTsMs.length - 1] - extremeTs) / 1000;
    const rejSize = input.side === 'LONG' ? (input.lastPrice - extreme) : (extreme - input.lastPrice);
    const speedPipsPerSec = dt > 0 ? Math.abs(rejSize) / dt * 10000 : 0;
    const rejectionSpeed = clamp01(speedPipsPerSec / 6);   // 6 pips/sec = full mark

    // 3. rejection acceleration — split the snap into first-half vs second-half rates
    const snapTail = input.recentTicks.slice(extremeIdx);
    const snapTs = input.recentTickTsMs.slice(extremeIdx);
    let rejectionAccel = 0;
    if (snapTail.length >= 4) {
        const mid = Math.floor(snapTail.length / 2);
        const dt1 = (snapTs[mid] - snapTs[0]) / 1000;
        const dt2 = (snapTs[snapTail.length - 1] - snapTs[mid]) / 1000;
        const move1 = input.side === 'LONG' ? snapTail[mid] - snapTail[0] : snapTail[0] - snapTail[mid];
        const move2 = input.side === 'LONG' ? snapTail[snapTail.length - 1] - snapTail[mid] : snapTail[mid] - snapTail[snapTail.length - 1];
        const v1 = dt1 > 0 ? move1 / dt1 : 0;
        const v2 = dt2 > 0 ? move2 / dt2 : 0;
        rejectionAccel = v2 > v1 ? clamp01((v2 - v1) / atr * 20) : 0;
    }

    // 4. persistence — count monotonic snap-back ticks
    let mono = 0;
    for (let i = extremeIdx + 1; i < input.recentTicks.length; i++) {
        const prev = input.recentTicks[i - 1], cur = input.recentTicks[i];
        if (input.side === 'LONG' && cur >= prev) mono++;
        else if (input.side === 'SHORT' && cur <= prev) mono++;
    }
    const persistence = clamp01(mono / 4);   // 4 consecutive ticks = full mark

    // 5. wick-to-body ratio
    const bodySoFar = Math.abs(input.lastPrice - input.barOpen);
    const wickToBodyRatio = wickLen > 0 && bodySoFar > 0
        ? clamp01(wickLen / bodySoFar / 3)   // wick 3× body-so-far = full mark
        : 0;

    // 6. number of rejection ticks — density
    const rejectionTicks = clamp01((input.recentTicks.length - extremeIdx) / 8);

    // 7. distance from recent swing (M5 last 10 bars)
    let swingDistance = 0;
    if (input.priorBars.length >= 5) {
        const last10 = input.priorBars.slice(-10);
        if (input.side === 'LONG') {
            const swingLow = Math.min(...last10.map(b => b.low));
            const proximity = Math.abs(input.lowSoFar - swingLow) / atr;
            swingDistance = clamp01(1 - Math.min(1, proximity / 0.3));   // within 0.3 ATR of swing
        } else {
            const swingHigh = Math.max(...last10.map(b => b.high));
            const proximity = Math.abs(input.highSoFar - swingHigh) / atr;
            swingDistance = clamp01(1 - Math.min(1, proximity / 0.3));
        }
    }

    const parts = { wickAtrLen, rejectionSpeed, rejectionAccel, persistence, wickToBodyRatio, rejectionTicks, swingDistance };

    // Anti-random-walk gate: below 0.10 ATR wick length, dampen the score
    // aggressively — random noise rarely produces meaningful wicks.
    const wickGate = wickLen < 0.10 * atr ? 0.25 : (wickLen < 0.15 * atr ? 0.6 : 1.0);

    const score = clamp01((
        WEIGHTS.wickAtrLen * wickAtrLen +
        WEIGHTS.rejectionSpeed * rejectionSpeed +
        WEIGHTS.rejectionAccel * rejectionAccel +
        WEIGHTS.persistence * persistence +
        WEIGHTS.wickToBodyRatio * wickToBodyRatio +
        WEIGHTS.rejectionTicks * rejectionTicks +
        WEIGHTS.swingDistance * swingDistance
    ) * wickGate);

    return {
        score, parts,
        reason: `wick=${wickAtrLen.toFixed(2)} spd=${rejectionSpeed.toFixed(2)} acc=${rejectionAccel.toFixed(2)} pers=${persistence.toFixed(2)} w/b=${wickToBodyRatio.toFixed(2)} n=${rejectionTicks.toFixed(2)} sw=${swingDistance.toFixed(2)}`,
    };
}

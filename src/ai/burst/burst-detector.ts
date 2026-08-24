/**
 * Burst Detector — Velocity + Momentum-Snap Detection
 * ====================================================
 * Watches the last N ticks/candles for the "snap" that precedes a
 * high-probability 60–180 s directional burst on forex multipliers.
 *
 * Signals fused:
 *   1. **Velocity (v)**  — first derivative of price over the last 20 s
 *                          (ticks) or last 3 M1 candles.  Normalised by ATR
 *                          so it is comparable across pairs.
 *   2. **Acceleration (a)** — second derivative.  A large |a| means the
 *                             market is *accelerating*, not merely trending.
 *                             This is the "snap".
 *   3. **Volume-of-attention (VoA)** — ratio of current tick-arrival rate
 *                                      to the 5-minute median.  A doubling
 *                                      of tick rate is a strong signal that
 *                                      a burst is forming.
 *   4. **BB-squeeze release** — Bollinger bandwidth was < 25th percentile
 *                               over the last 20 candles AND the current
 *                               close broke either band.
 *
 * A burst fires only when at LEAST 3 of these 4 sub-signals agree.
 * That "3-of-4" rule is intentionally strict: false-positive bursts cost
 * money (chases into reversal); false-negatives only cost opportunity.
 *
 * When a burst is confirmed, the module returns:
 *   - direction: +1 (up) / -1 (down)
 *   - expectedDurationSec: 60–180 s window
 *   - confidence: 0..1 — used by execution as an extra multiplier
 *   - suggestedTpAtrMult / suggestedSlAtrMult — precision-exit hints
 */

import { atr, bollinger, IndicatorSnapshot } from '../engine/indicator-engine';
import { closedBarsOnly }                    from '../engine/no-repaint-guard';

export interface Candle {
    epoch: number; open: number; high: number; low: number; close: number; volume?: number;
}

export interface BurstSignal {
    fired: boolean;
    direction: -1 | 0 | 1;
    confidence: number;              // 0..1
    velocityAtr: number;             // v / ATR (unitless)
    accelerationAtr: number;         // a / ATR
    voa: number;                     // tick-rate multiple (1 = normal)
    bbSqueezeRelease: boolean;
    expectedDurationSec: number;     // 60..180
    suggestedTpAtrMult: number;      // precision exit
    suggestedSlAtrMult: number;
    reason: string;
}

const CLEAR: BurstSignal = {
    fired: false, direction: 0, confidence: 0,
    velocityAtr: 0, accelerationAtr: 0, voa: 1,
    bbSqueezeRelease: false, expectedDurationSec: 0,
    suggestedTpAtrMult: 2.5, suggestedSlAtrMult: 1.0,
    reason: 'no burst',
};

export interface BurstInput {
    candles: Candle[];       // recent 60–200 M1 candles (CLOSED bars only)
    ticks: number[];         // last few hundred ticks
    tickEpochsMs: number[];  // parallel to `ticks`, ms timestamps
    /** v5.5.5 — injectable clock for deterministic replay. Defaults to Date.now(). */
    now?: number;
    /** v5.5.5 — bar width in seconds; inferred from the series when omitted. */
    timeframeSec?: number;
}

/** Percentile of x in xs. */
function percentile(xs: number[], x: number): number {
    if (!xs.length) return 50;
    const sorted = [...xs].sort((a, b) => a - b);
    const rank = sorted.findIndex(v => v >= x);
    return rank < 0 ? 100 : (rank / sorted.length) * 100;
}

/** Median of xs — used for tick-rate baseline. */
function median(xs: number[]): number {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]);
}

/**
 * Compute velocity and acceleration in ATR-normalised units over the
 * last k candles (default 3 M1 = ~180 s).  Using candles instead of raw
 * ticks makes the derivative resistant to single-tick noise.
 */
function velocityAndAccel(candles: Candle[], atrVal: number, k = 3): { v: number; a: number } {
    if (candles.length < k + 1 || !isFinite(atrVal) || atrVal <= 0) return { v: 0, a: 0 };
    const closes = candles.slice(-k - 1).map(c => c.close);
    // Per-candle velocity (price change per M1 bar) normalised by ATR.
    // v = 1 means the last candle moved by 1 ATR — that's a strong move.
    const v1 = (closes[closes.length - 1] - closes[closes.length - 2]) / atrVal;
    const v0 = (closes[1] - closes[0]) / atrVal;
    // Acceleration = change in velocity over the interval
    const a = (v1 - v0) / Math.max(1, closes.length - 2);
    return { v: v1, a };
}

/**
 * Volume-of-attention = current tick-arrival rate (per second) divided by
 * the 5-minute median tick-arrival rate.
 */
function volumeOfAttention(tickEpochsMs: number[], recentSeconds = 20, medianWindowSec = 300): number {
    if (tickEpochsMs.length < 10) return 1;
    const now = tickEpochsMs[tickEpochsMs.length - 1];
    const recent = tickEpochsMs.filter(t => t >= now - recentSeconds * 1000).length / recentSeconds;
    // Build per-second histogram over medianWindowSec
    const buckets = new Map<number, number>();
    for (const t of tickEpochsMs) {
        if (t < now - medianWindowSec * 1000) continue;
        const s = Math.floor(t / 1000);
        buckets.set(s, (buckets.get(s) ?? 0) + 1);
    }
    const rates = Array.from(buckets.values());
    const base = median(rates);
    return base > 0 ? recent / base : 1;
}

/**
 * Detect Bollinger-squeeze-release: bandwidth was in the bottom quartile
 * over the last 20 candles AND price just broke outside one band.
 */
function bbSqueezeRelease(candles: Candle[]): { released: boolean; direction: -1 | 0 | 1 } {
    if (candles.length < 25) return { released: false, direction: 0 };
    const closes = candles.map(c => c.close);
    const bwSeries: number[] = [];
    for (let i = 20; i < candles.length; i++) {
        const bb = bollinger(closes.slice(0, i), 20, 2);
        if (isFinite(bb.bandwidth)) bwSeries.push(bb.bandwidth);
    }
    if (bwSeries.length < 20) return { released: false, direction: 0 };
    const currentBw = bwSeries[bwSeries.length - 1];
    const priorBw = bwSeries.slice(-20, -1);
    const p = percentile(priorBw, currentBw);
    if (p > 25) return { released: false, direction: 0 };
    const bb = bollinger(closes, 20, 2);
    const last = closes[closes.length - 1];
    if (last > bb.upper) return { released: true, direction: +1 };
    if (last < bb.lower) return { released: true, direction: -1 };
    return { released: false, direction: 0 };
}

/**
 * Main detector.  Fires only when at least 3 of the 4 sub-signals agree.
 * Returns a burst signal — the executor treats this as a *hint*, gated
 * by the LightGBM confidence and validation floors as usual.
 */
export function detectBurst(input: BurstInput): BurstSignal {
    const { tickEpochsMs } = input;

    // ── v5.5.5 NO-REPAINT (LAYER 3: module-local defence in depth) ──
    // ATR, velocity, acceleration and the BB-squeeze release are all OHLC
    // aggregates. Computing them over a forming bar made `direction` and
    // `confidence` flip mid-bar — the most damaging repaint in the system,
    // because this signal drives live entries and TP/SL geometry.
    // Idempotent: a no-op when the caller already guarded.
    const candles = closedBarsOnly(input.candles, {
        now: input.now,
        timeframeSec: input.timeframeSec,
    });
    if (candles.length < 25 || tickEpochsMs.length < 20) return CLEAR;

    const atrVal = atr(candles, 14);
    if (!isFinite(atrVal) || atrVal <= 0) return CLEAR;

    // 1. velocity + acceleration
    const { v, a } = velocityAndAccel(candles, atrVal, 3);

    // 2. VoA
    const voa = volumeOfAttention(tickEpochsMs);

    // 3. BB squeeze release
    const bb = bbSqueezeRelease(candles);

    // Direction: prefer BB direction if released; else sign of velocity
    const dir: -1 | 0 | 1 = bb.released ? bb.direction : (v > 0 ? 1 : v < 0 ? -1 : 0);
    if (dir === 0) return CLEAR;

    // 3-of-4 rule — each sub-signal contributes a boolean vote
    // NB: the direction of velocity/accel must AGREE with `dir`
    // Thresholds calibrated on M1 forex: v=0.5 means the latest candle
    // moved ~half an ATR; a=0.15 means velocity accelerated by ~15% of ATR.
    const voteVelocity     = Math.abs(v) > 0.50 && Math.sign(v) === dir;
    const voteAcceleration = Math.abs(a) > 0.15 && Math.sign(a) === dir;
    const voteVoa          = voa > 1.7;
    const voteBb           = bb.released;

    const votes = [voteVelocity, voteAcceleration, voteVoa, voteBb].filter(Boolean).length;
    if (votes < 3) return { ...CLEAR, velocityAtr: v, accelerationAtr: a, voa, bbSqueezeRelease: bb.released, direction: dir, reason: `only ${votes}/4 signals` };

    // Confidence: combine sub-scores (normalised against generous ceilings)
    const cVel  = Math.min(1, Math.abs(v) / 1.2);
    const cAcc  = Math.min(1, Math.abs(a) / 0.5);
    const cVoa  = Math.min(1, (voa - 1) / 2);
    const cBb   = voteBb ? 1 : 0;
    const confidence = 0.35 * cVel + 0.30 * cAcc + 0.20 * cVoa + 0.15 * cBb;

    // Expected duration scales with confidence: 60 s at low, 180 s at high
    const expectedDurationSec = Math.round(60 + 120 * confidence);

    // Precision exit hints — tighter TP than static default because bursts
    // resolve quickly and we do NOT want to give profit back.
    //   TP  = 1.8 × ATR  (vs static 2.5)
    //   SL  = 0.9 × ATR  (vs static 1.0)
    const suggestedTpAtrMult = 1.8;
    const suggestedSlAtrMult = 0.9;

    return {
        fired: true, direction: dir, confidence,
        velocityAtr: v, accelerationAtr: a, voa, bbSqueezeRelease: bb.released,
        expectedDurationSec,
        suggestedTpAtrMult, suggestedSlAtrMult,
        reason: `BURST ${dir > 0 ? 'UP' : 'DOWN'} · v=${v.toFixed(3)} a=${a.toFixed(4)} VoA=${voa.toFixed(2)} BB=${voteBb ? 'yes' : 'no'} (${votes}/4)`,
    };
}

/**
 * Precision-exit test.  Called on every tick while a burst-triggered
 * position is open.  Returns true when we should close, matching the
 * user's spec: *"grab the profit and get out immediately"*.
 *
 * Rules (any one triggers):
 *   - profit >= 60 % of expected TP within first 20 % of expected time
 *     (fast-move exit — velocity has been exceptionally kind)
 *   - profit >= expected TP (always)
 *   - price has gone flat: no movement > 0.25 × ATR for 30 s
 *   - the burst's expectedDurationSec has elapsed and profit < 40 % of TP
 *     (thesis failed — get out flat before mean reversion)
 */
export interface PrecisionExitInput {
    burstOpenedAt: number;         // ms
    expectedDurationSec: number;
    profitPips: number;
    targetTpPips: number;
    lastNPricesInLast30s: number[];
    atrPips: number;
    now?: number;
}

export function shouldPrecisionExit(i: PrecisionExitInput): { exit: boolean; reason: string } {
    const now = i.now ?? Date.now();
    const elapsedSec = (now - i.burstOpenedAt) / 1000;
    const elapsedFrac = elapsedSec / Math.max(1, i.expectedDurationSec);
    const profitFrac = i.targetTpPips > 0 ? i.profitPips / i.targetTpPips : 0;

    if (profitFrac >= 1) return { exit: true, reason: 'burst_tp_hit' };
    if (elapsedFrac < 0.20 && profitFrac >= 0.60) {
        return { exit: true, reason: `burst_fastmove ${(profitFrac * 100).toFixed(0)}% in ${(elapsedFrac * 100).toFixed(0)}% time` };
    }
    if (i.lastNPricesInLast30s.length >= 5) {
        const min = Math.min(...i.lastNPricesInLast30s);
        const max = Math.max(...i.lastNPricesInLast30s);
        const rangePips = (max - min) * 10000;  // rough forex pips
        if (rangePips < 0.25 * i.atrPips) {
            return { exit: true, reason: `burst_flat range=${rangePips.toFixed(1)}p` };
        }
    }
    if (elapsedFrac >= 1 && profitFrac < 0.40) {
        return { exit: true, reason: `burst_expired profit=${(profitFrac * 100).toFixed(0)}%` };
    }
    return { exit: false, reason: '' };
}

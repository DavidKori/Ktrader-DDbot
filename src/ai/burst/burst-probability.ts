/**
 * Burst Probability Layer — v5.5.1
 * =================================
 * Estimates the probability the current rejection is transitioning into
 * a genuine directional burst (rapid body expansion after a sweep).
 *
 * Progression: Sweep → Wick → Absorption → BURST BEGINS → Enter.
 *
 * Signals (strictly causal, use only data ≤ t):
 *   1. Directional consistency of ticks AFTER the extreme
 *   2. Velocity expansion (mean tick move on tail vs full window)
 *   3. Body / wick ratio (body ≥ 50% of wick → real breakout)
 *   4. Range expansion (bar range so far vs ATR)
 *
 * Output p ∈ [0,1] — MULTIPLIED into final confidence so uncertainty
 * suppresses conviction, mirroring the absorption layer.
 */

export interface BurstProbabilityInput {
    side: 'LONG' | 'SHORT';
    barOpen: number;
    lowSoFar: number;
    highSoFar: number;
    lastPrice: number;
    recentTicks: number[];
    recentTickTsMs: number[];
    extremeIdx: number;
    atr: number;
}

export interface BurstProbabilityResult {
    probability: number;
    parts: {
        directionalConsistency: number;
        velocityExpansion: number;
        bodyToWick: number;
        rangeExpansion: number;
    };
    reason: string;
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

export function estimateBurstProbability(input: BurstProbabilityInput): BurstProbabilityResult {
    const zero: BurstProbabilityResult = {
        probability: 0,
        parts: { directionalConsistency: 0, velocityExpansion: 0, bodyToWick: 0, rangeExpansion: 0 },
        reason: 'insufficient data',
    };
    if (input.recentTicks.length < 6 || input.atr <= 0 || input.extremeIdx < 0) return zero;

    const tail = input.recentTicks.slice(input.extremeIdx + 1);
    if (tail.length < 3) return zero;

    let consistent = 0;
    for (let i = 1; i < tail.length; i++) {
        const d = tail[i] - tail[i - 1];
        if ((input.side === 'LONG' && d > 0) || (input.side === 'SHORT' && d < 0)) consistent++;
    }
    const directionalConsistency = clamp01(consistent / (tail.length - 1));

    let sumAll = 0, sumTail = 0;
    for (let i = 1; i < input.recentTicks.length; i++) sumAll += Math.abs(input.recentTicks[i] - input.recentTicks[i - 1]);
    for (let i = 1; i < tail.length; i++) sumTail += Math.abs(tail[i] - tail[i - 1]);
    const mAll  = sumAll  / Math.max(1, input.recentTicks.length - 1);
    const mTail = sumTail / Math.max(1, tail.length - 1);
    const velocityExpansion = mAll > 0 ? clamp01((mTail / mAll - 1) / 1.0) : 0;

    const wickLen = input.side === 'LONG'
        ? Math.max(0, input.barOpen - input.lowSoFar)
        : Math.max(0, input.highSoFar - input.barOpen);
    const bodyLen = Math.abs(input.lastPrice - input.barOpen);
    const bodyToWick = wickLen > 0 ? clamp01(bodyLen / wickLen / 0.5) : 0;

    const rangeSoFar = input.highSoFar - input.lowSoFar;
    const rangeExpansion = clamp01(rangeSoFar / input.atr / 1.2);

    const parts = { directionalConsistency, velocityExpansion, bodyToWick, rangeExpansion };
    const probability = clamp01(
        0.35 * directionalConsistency +
        0.25 * velocityExpansion +
        0.25 * bodyToWick +
        0.15 * rangeExpansion
    );

    return {
        probability, parts,
        reason: `cons=${directionalConsistency.toFixed(2)} vel=${velocityExpansion.toFixed(2)} b/w=${bodyToWick.toFixed(2)} rng=${rangeExpansion.toFixed(2)} → p=${probability.toFixed(2)}`,
    };
}

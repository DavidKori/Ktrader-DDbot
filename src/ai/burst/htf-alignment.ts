/**
 * Higher-Timeframe Alignment — v5.5 (M5 refinement §5)
 * =====================================================
 * Determines the dominant M15 + H1 bias so counter-trend wicks require a
 * higher score to trigger.
 *
 * Bias per timeframe:
 *   +1 BULLISH   close > EMA(21) AND EMA(21) rising
 *   -1 BEARISH   close < EMA(21) AND EMA(21) falling
 *    0 NEUTRAL   otherwise
 *
 * Consensus: (m15Bias + h1Bias) — range -2..+2.
 *   +2 = strong bull → LONG bursts get +0.15 confidence boost, SHORT get −0.20
 *   -2 = strong bear → SHORT gets boost, LONG gets penalty
 *   ±1 = mild lean
 *    0 = neutral (no adjustment)
 */

export interface Candle { open: number; high: number; low: number; close: number; epochMs: number; }

export interface HtfInput {
    m15Bars: Candle[];
    h1Bars: Candle[];
}

export interface HtfAlignment {
    m15Bias: -1 | 0 | 1;
    h1Bias: -1 | 0 | 1;
    consensus: -2 | -1 | 0 | 1 | 2;
    label: 'STRONG_BULL' | 'MILD_BULL' | 'NEUTRAL' | 'MILD_BEAR' | 'STRONG_BEAR';
    /** Amount to add to the LONG side confidence (negative for penalty). */
    longAdjust: number;
    /** Amount to add to the SHORT side confidence. */
    shortAdjust: number;
    reason: string;
}

function ema(xs: number[], n: number): number {
    if (xs.length < n) return NaN;
    const k = 2 / (n + 1);
    let e = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
    for (let i = n; i < xs.length; i++) e = xs[i] * k + e * (1 - k);
    return e;
}

function biasOf(bars: Candle[]): -1 | 0 | 1 {
    if (bars.length < 25) return 0;
    const closes = bars.map(b => b.close);
    const e = ema(closes, 21);
    const ePrev = ema(closes.slice(0, -5), 21);
    if (!isFinite(e) || !isFinite(ePrev)) return 0;
    const c = bars[bars.length - 1].close;
    const rising = e > ePrev;
    if (c > e && rising) return 1;
    if (c < e && !rising) return -1;
    return 0;
}

export function alignHtf(input: HtfInput): HtfAlignment {
    const m15 = biasOf(input.m15Bars);
    const h1 = biasOf(input.h1Bars);
    const consensus = (m15 + h1) as HtfAlignment['consensus'];
    let label: HtfAlignment['label'] = 'NEUTRAL';
    if (consensus === 2)  label = 'STRONG_BULL';
    else if (consensus === 1)  label = 'MILD_BULL';
    else if (consensus === -1) label = 'MILD_BEAR';
    else if (consensus === -2) label = 'STRONG_BEAR';

    let longAdjust = 0, shortAdjust = 0;
    if (consensus === 2)  { longAdjust = +0.15; shortAdjust = -0.20; }
    if (consensus === 1)  { longAdjust = +0.08; shortAdjust = -0.10; }
    if (consensus === -1) { longAdjust = -0.10; shortAdjust = +0.08; }
    if (consensus === -2) { longAdjust = -0.20; shortAdjust = +0.15; }

    return {
        m15Bias: m15, h1Bias: h1, consensus, label,
        longAdjust, shortAdjust,
        reason: `M15=${m15} H1=${h1} → ${label}`,
    };
}

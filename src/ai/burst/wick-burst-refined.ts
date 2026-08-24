/**
 * Refined Wick-Burst Engine — v5.5 (M5 intrabar quick-profit-taker)
 * ===================================================================
 * Composes the six new v5.5 layers into ONE decision:
 *
 *   1. Wick-Quality Score          (§1)
 *   2. Liquidity Context Score     (§2)
 *   3. Absorption Probability      (Absorption Layer)
 *   4. Burst Confirmation          (existing burst-detector + accel)
 *   5. HTF Alignment               (§5)
 *   6. Adaptive Thresholds         (existing adaptive-thresholds)
 *
 * Regime classification and existing gates (kill switch, edge/cost,
 * correlation, freq, gap) remain enforced UPSTREAM by unified-strategy.
 * This module produces a raw refined signal + confidence.
 *
 * Strict causality: everything reads only "so-far" fields.
 */

import { scoreWickQuality, WickQualityInput } from './wick-quality';
import { scoreLiquidityContext, LiquidityInput } from './liquidity-context';
import { estimateAbsorption, AbsorptionInput } from './absorption-probability';
import { alignHtf, HtfInput } from './htf-alignment';

export interface WickBurstRefinedInput {
    barOpen: number;
    lowSoFar: number;
    highSoFar: number;
    lastPrice: number;
    recentTicks: number[];
    recentTickTsMs: number[];
    priorM5: { open: number; high: number; low: number; close: number; epochMs: number }[];
    priorM15: { open: number; high: number; low: number; close: number; epochMs: number }[];
    priorH1: { open: number; high: number; low: number; close: number; epochMs: number }[];
    sessionHigh?: number;
    sessionLow?: number;
    prevDayHigh?: number;
    prevDayLow?: number;
    baselineTsMs?: number[];
    confidenceFloor?: number;
}

export interface WickBurstRefinedResult {
    signal: 'LONG' | 'SHORT' | 'NONE';
    confidence: number;                     // 0..1 final decision
    partials: {
        wickQuality: number;
        liquidity: number;
        absorption: number;
        htfAdjust: number;
    };
    reason: string;
    peakBurstVelocity: number;              // pips/sec, for the exit engine
    partialTrigger: boolean;
}

const WEIGHTS = {
    wick: 0.40,
    liquidity: 0.25,
    // absorption multiplies the raw signal — not added, so uncertainty
    // suppresses trade size rather than adding fake bullishness
    burst: 0.35,
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

function peakVelocity(ticks: number[], tsMs: number[]): number {
    if (ticks.length < 4) return 0;
    let peak = 0;
    for (let i = 2; i < ticks.length; i++) {
        const dt = (tsMs[i] - tsMs[i - 2]) / 1000;
        if (dt <= 0) continue;
        const v = Math.abs(ticks[i] - ticks[i - 2]) / dt * 10000;   // pips/sec
        if (v > peak) peak = v;
    }
    return peak;
}

export function evaluateWickBurstRefined(input: WickBurstRefinedInput): WickBurstRefinedResult {
    const floor = input.confidenceFloor ?? 0.62;
    const atr = atrOf(input.priorM5);
    if (!isFinite(atr) || atr <= 0) {
        return { signal: 'NONE', confidence: 0, partials: { wickQuality: 0, liquidity: 0, absorption: 0, htfAdjust: 0 }, reason: 'warmup', peakBurstVelocity: 0, partialTrigger: false };
    }

    // Determine candidate side from which wick is dominant
    const lowerWick = Math.max(0, input.barOpen - input.lowSoFar);
    const upperWick = Math.max(0, input.highSoFar - input.barOpen);
    const side: 'LONG' | 'SHORT' | null =
        lowerWick > upperWick && lowerWick > atr * 0.15 ? 'LONG' :
        upperWick > lowerWick && upperWick > atr * 0.15 ? 'SHORT' : null;
    if (!side) {
        return { signal: 'NONE', confidence: 0, partials: { wickQuality: 0, liquidity: 0, absorption: 0, htfAdjust: 0 }, reason: 'no dominant wick', peakBurstVelocity: 0, partialTrigger: false };
    }

    // 1. wick quality
    const wqInput: WickQualityInput = {
        barOpen: input.barOpen,
        lowSoFar: input.lowSoFar,
        highSoFar: input.highSoFar,
        lastPrice: input.lastPrice,
        recentTicks: input.recentTicks,
        recentTickTsMs: input.recentTickTsMs,
        priorBars: input.priorM5,
        side,
    };
    const wq = scoreWickQuality(wqInput);

    // 2. liquidity context
    const wickExtreme = side === 'LONG' ? input.lowSoFar : input.highSoFar;
    const lc = scoreLiquidityContext({
        side, wickExtreme,
        m5Bars: input.priorM5, m15Bars: input.priorM15,
        sessionHigh: input.sessionHigh, sessionLow: input.sessionLow,
        prevDayHigh: input.prevDayHigh, prevDayLow: input.prevDayLow,
    });

    // 3. absorption
    const extremeIdx = side === 'LONG'
        ? input.recentTicks.reduce((min, v, i, a) => v < a[min] ? i : min, 0)
        : input.recentTicks.reduce((max, v, i, a) => v > a[max] ? i : max, 0);
    const absorption = estimateAbsorption({
        side, recentTicks: input.recentTicks, recentTickTsMs: input.recentTickTsMs,
        baselineTsMs: input.baselineTsMs, extremeIdx, atr,
    });

    // 4. HTF alignment
    const htf = alignHtf({ m15Bars: input.priorM15, h1Bars: input.priorH1 });
    const htfAdjust = side === 'LONG' ? htf.longAdjust : htf.shortAdjust;

    // 5. combine — burst is proxied by rejection speed + accel (already in wick.parts)
    const burstProxy = 0.5 * wq.parts.rejectionSpeed + 0.5 * wq.parts.rejectionAccel;
    let raw =
        WEIGHTS.wick * wq.score +
        WEIGHTS.liquidity * lc.score +
        WEIGHTS.burst * burstProxy;

    // Absorption acts as a MULTIPLIER (uncertainty scales down conviction)
    raw = raw * (0.5 + 0.5 * absorption.probability);

    // HTF adjustment
    raw = Math.max(0, Math.min(1, raw + htfAdjust));

    const partialTrigger = wq.parts.wickToBodyRatio > 0.3 && wq.parts.persistence > 0.5;

    if (raw < floor) {
        return {
            signal: 'NONE', confidence: raw,
            partials: { wickQuality: wq.score, liquidity: lc.score, absorption: absorption.probability, htfAdjust },
            reason: `raw ${raw.toFixed(2)} < floor ${floor} — ${wq.reason} | liq[${lc.hits.join(',') || '-'}] | ${absorption.reason} | ${htf.reason}`,
            peakBurstVelocity: 0,
            partialTrigger: false,
        };
    }

    return {
        signal: side,
        confidence: raw,
        partials: { wickQuality: wq.score, liquidity: lc.score, absorption: absorption.probability, htfAdjust },
        reason: `${side} conf=${raw.toFixed(2)} · ${wq.reason} · liq[${lc.hits.join(',') || '-'}] · ${absorption.reason} · ${htf.reason}`,
        peakBurstVelocity: peakVelocity(input.recentTicks, input.recentTickTsMs),
        partialTrigger,
    };
}

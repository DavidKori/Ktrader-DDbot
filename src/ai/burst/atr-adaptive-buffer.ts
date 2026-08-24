/**
 * ATR-Adaptive Buffer
 * ===================
 * Widens (or tightens) the TP / SL multipliers around a burst signal
 * based on **realised market volatility** so the "burst has enough room
 * to breathe without being choked by normal market noise" (user spec).
 *
 * Two inputs drive the buffer:
 *
 *   1. **ATR percentile** — where the current ATR sits inside the last
 *      120 M1 candles.  Percentile > 75 → high-volatility session
 *      (London-open, NY overlap, news).  We widen TP/SL by up to +40 %.
 *      Percentile < 25 → dead session (Asia lull) → we tighten by -20 %
 *      because moves rarely complete.
 *
 *   2. **Session flag** — computed from UTC hour of day:
 *        - LDN_NY_OVERLAP  (13-16 UTC)  → extra +15 % buffer
 *        - LDN_OPEN        (07-09 UTC)  → extra +10 %
 *        - ASIA_LULL       (22-02 UTC)  → extra -15 %
 *
 *   The final multiplier is clamped to [0.6, 1.7] × the burst's base
 *   suggestion (from BurstDetector).  Anything outside that range is
 *   suspicious and would break the risk-reward invariant.
 *
 * Public helper `computeAdaptiveBuffer` returns the final TP/SL ATR
 * multipliers used by execution.
 */

import { atr, Candle } from '../engine/indicator-engine';
import { closedBarsOnly } from '../engine/no-repaint-guard';

export type Session =
    | 'ASIA_LULL' | 'ASIA_MAIN' | 'LDN_OPEN' | 'LDN_MAIN'
    | 'LDN_NY_OVERLAP' | 'NY_MAIN' | 'NY_CLOSE' | 'OFF';

export interface AdaptiveBufferInput {
    /** CLOSED bars only. Guarded internally for defence in depth. */
    candles: Candle[];
    baseTpAtrMult: number;         // e.g. 1.8 from BurstDetector
    baseSlAtrMult: number;         // e.g. 0.9
    nowUtcMs?: number;
    /** v5.5.5 — bar width in seconds; inferred from the series when omitted. */
    timeframeSec?: number;
}

export interface AdaptiveBufferOutput {
    tpAtrMult: number;
    slAtrMult: number;
    atrPercentile: number;
    session: Session;
    widenFactor: number;
    reason: string;
}

export function classifySession(nowUtcMs = Date.now()): Session {
    const h = new Date(nowUtcMs).getUTCHours();
    if (h >= 22 || h < 2)  return 'ASIA_LULL';
    if (h >= 2  && h < 7)  return 'ASIA_MAIN';
    if (h >= 7  && h < 9)  return 'LDN_OPEN';
    if (h >= 9  && h < 13) return 'LDN_MAIN';
    if (h >= 13 && h < 16) return 'LDN_NY_OVERLAP';
    if (h >= 16 && h < 20) return 'NY_MAIN';
    if (h >= 20 && h < 22) return 'NY_CLOSE';
    return 'OFF';
}

function atrPercentile(candles: Candle[], window = 120): number {
    if (candles.length < 20) return 50;
    const atrs: number[] = [];
    const step = Math.max(1, Math.floor(candles.length / window));
    for (let i = 20; i < candles.length; i += step) {
        const a = atr(candles.slice(0, i), 14);
        if (isFinite(a)) atrs.push(a);
    }
    if (atrs.length < 5) return 50;
    const current = atrs[atrs.length - 1];
    const sorted = [...atrs].sort((a, b) => a - b);
    const rank = sorted.findIndex(v => v >= current);
    return rank < 0 ? 100 : (rank / sorted.length) * 100;
}

export function computeAdaptiveBuffer(input: AdaptiveBufferInput): AdaptiveBufferOutput {
    const { baseTpAtrMult, baseSlAtrMult } = input;
    const now = input.nowUtcMs ?? Date.now();

    // ── v5.5.5 NO-REPAINT + LOOK-AHEAD FIX ──
    // `atrPercentile` ranks the CURRENT ATR against a distribution built from
    // closed-bar prefixes. When the newest bar was still forming, a
    // forming-bar ATR was compared against a closed-bar distribution — a
    // mixed-causality comparison that made TP/SL geometry drift within a bar.
    // Guarding here makes both sides of the comparison causal.
    const candles = closedBarsOnly(input.candles, {
        now,
        timeframeSec: input.timeframeSec,
    });

    const p = atrPercentile(candles);
    const session = classifySession(now);

    // 1. Percentile-based widen factor
    let factor = 1.0;
    if      (p >= 90) factor = 1.40;
    else if (p >= 75) factor = 1.25;
    else if (p >= 50) factor = 1.10;
    else if (p >= 25) factor = 1.00;
    else              factor = 0.80;

    // 2. Session bonus
    const sessionBonus: Partial<Record<Session, number>> = {
        LDN_NY_OVERLAP: 0.15,
        LDN_OPEN:       0.10,
        NY_MAIN:        0.05,
        ASIA_LULL:     -0.15,
        OFF:           -0.10,
    };
    factor += sessionBonus[session] ?? 0;

    // Clamp
    factor = Math.max(0.60, Math.min(1.70, factor));

    const tpAtrMult = baseTpAtrMult * factor;
    const slAtrMult = baseSlAtrMult * factor;

    return {
        tpAtrMult, slAtrMult,
        atrPercentile: p,
        session,
        widenFactor: factor,
        reason: `ATR%=${p.toFixed(0)} · session=${session} · widen=${factor.toFixed(2)}x`,
    };
}

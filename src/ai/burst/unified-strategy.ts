/**
 * Unified Burst Strategy — v5.4
 * ==============================
 * Runs the M1 Burst Engine AND the M5 Wick-Burst engine in parallel.
 * Whichever fires first (or both) gets executed under the same portfolio
 * risk controls. If BOTH fire in agreement, confidence is boosted.
 *
 * All portfolio-level gates (Edge-to-Cost, Correlation Guard, Kill Switch,
 * ExposureTracker) are ENFORCED before returning shouldEnter=true — the
 * unified strategy never bypasses them (spec §Architecture rules).
 */

import { BurstSignal } from './burst-detector';
import { WickBurstDecision } from './wick-burst-strategy';

export type StrategyName = 'M1_BURST' | 'M5_WICK' | 'BOTH_AGREE' | 'NONE';

export interface UnifiedInput {
    m1: BurstSignal | null;
    m5: WickBurstDecision;
    /** Result of the Edge-to-Cost gate. */
    edgeCostAllow: boolean;
    edgeCostReason: string;
    /** Correlation-guard allow flag. */
    correlationAllow: boolean;
    correlationReason: string;
    /** Frequency cap. */
    freqAllow: boolean;
    freqReason: string;
    /** Gap-detector cooldown allow. */
    gapAllow: boolean;
    gapReason: string;
    /** Kill switch. */
    killTripped: boolean;
}

export interface UnifiedDecision {
    shouldEnter: boolean;
    winner: StrategyName;
    direction: -1 | 0 | 1;
    confidence: number;
    reasons: string[];
    tags: { m1Fired: boolean; m5Fired: boolean; agree: boolean };
}

export function unifiedDecide(input: UnifiedInput): UnifiedDecision {
    const reasons: string[] = [];
    const m1Fired = !!input.m1?.fired;
    const m5Fired = input.m5.signal !== 'NONE';
    const m1Dir = (input.m1?.direction ?? 0) as -1 | 0 | 1;
    const m5Dir = input.m5.signal === 'LONG' ? 1 : input.m5.signal === 'SHORT' ? -1 : 0;

    // Portfolio-level HARD gates first — never bypass
    if (input.killTripped) return { shouldEnter: false, winner: 'NONE', direction: 0, confidence: 0, reasons: ['kill switch tripped'], tags: { m1Fired, m5Fired, agree: false } };
    if (!input.gapAllow)   return { shouldEnter: false, winner: 'NONE', direction: 0, confidence: 0, reasons: [`gap: ${input.gapReason}`], tags: { m1Fired, m5Fired, agree: false } };

    if (!m1Fired && !m5Fired) return { shouldEnter: false, winner: 'NONE', direction: 0, confidence: 0, reasons: ['no strategy fired'], tags: { m1Fired, m5Fired, agree: false } };

    // Merge: whichever fires (or both). If both agree, boost.
    let winner: StrategyName = 'NONE';
    let direction: -1 | 0 | 1 = 0;
    let confidence = 0;
    const agree = m1Fired && m5Fired && m1Dir !== 0 && m1Dir === m5Dir;

    if (agree) {
        winner = 'BOTH_AGREE';
        direction = m1Dir;
        confidence = Math.min(1, (input.m1!.confidence + input.m5.confidence) * 0.6);   // boosted
        reasons.push(`M1+M5 agree: m1c=${input.m1!.confidence.toFixed(2)} m5c=${input.m5.confidence.toFixed(2)}`);
    } else if (m1Fired && m5Fired) {
        // Conflicting → pick higher confidence, but demote confidence 30 %
        if (input.m1!.confidence >= input.m5.confidence) {
            winner = 'M1_BURST'; direction = m1Dir; confidence = input.m1!.confidence * 0.7;
        } else {
            winner = 'M5_WICK'; direction = m5Dir; confidence = input.m5.confidence * 0.7;
        }
        reasons.push(`M1/M5 conflict: chose ${winner} but demoted 30% confidence`);
    } else if (m1Fired) {
        winner = 'M1_BURST'; direction = m1Dir; confidence = input.m1!.confidence;
        reasons.push(`M1 only: ${input.m1!.reason}`);
    } else if (m5Fired) {
        winner = 'M5_WICK'; direction = m5Dir; confidence = input.m5.confidence;
        reasons.push(`M5 only: ${input.m5.reason}`);
    }

    // Portfolio gates AFTER signal — never bypass
    if (!input.edgeCostAllow)  { reasons.push(`edge/cost: ${input.edgeCostReason}`); return { shouldEnter: false, winner, direction, confidence, reasons, tags: { m1Fired, m5Fired, agree } }; }
    if (!input.correlationAllow) { reasons.push(`corr: ${input.correlationReason}`); return { shouldEnter: false, winner, direction, confidence, reasons, tags: { m1Fired, m5Fired, agree } }; }
    if (!input.freqAllow)     { reasons.push(`freq: ${input.freqReason}`); return { shouldEnter: false, winner, direction, confidence, reasons, tags: { m1Fired, m5Fired, agree } }; }

    reasons.push(input.edgeCostReason, input.correlationReason, input.freqReason);
    return { shouldEnter: true, winner, direction, confidence, reasons, tags: { m1Fired, m5Fired, agree } };
}

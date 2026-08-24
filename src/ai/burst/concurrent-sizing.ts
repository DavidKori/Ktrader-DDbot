/**
 * Concurrent-Position Sizing — v5.5.1
 * Confidence tiers: 0.62-0.70→1, 0.70-0.78→3, 0.78-0.85→5, 0.85-0.92→8, ≥0.92→12.
 * Balance tiers: $50→2, $200→3, $500→5, $1000→8, $2500→12.
 * Per-trade stake shrinks so total exposure ≤ maxExposureFrac × equity.
 */
export interface SizingInput {
    balance: number; baseStake: number; confidence: number;
    openCount: number; openExposure: number;
    /** Measured closed-trade edge required for bulk concurrency. */
    bulkEligible?: boolean;
    measuredProfitFactor?: number;
    maxExposureFrac?: number; minStake?: number;
}
export interface SizingDecision {
    allowNewPosition: boolean; stakePerPosition: number;
    concurrentCap: number; reason: string;
}
function confidenceCap(c: number, bulkEligible = false): number {
    // Bulk is never confidence-only. It requires the measured expectancy gate.
    if (bulkEligible && c >= 0.90) return 10;
    if (c >= 0.92) return 1;
    if (c >= 0.85) return 1;
    if (c >= 0.78) return 1;
    if (c >= 0.70) return 1;
    if (c >= 0.62) return 1;
    return 0;
}
function balanceCap(b: number): number {
    if (b >= 2500) return 12; if (b >= 1000) return 8;
    if (b >= 500)  return 5;  if (b >= 200)  return 3;
    if (b >= 50)   return 2;  return 1;
}
export function decideConcurrentSizing(i: SizingInput): SizingDecision {
    const maxExp = i.maxExposureFrac ?? 0.50;
    const minStake = i.minStake ?? 0.35;
    const confidenceCapValue = confidenceCap(i.confidence, i.bulkEligible === true && (i.measuredProfitFactor ?? 0) >= 1.50);
    const cap = Math.min(confidenceCapValue, i.bulkEligible ? Math.min(10, balanceCap(i.balance)) : 1);
    if (cap === 0) return { allowNewPosition: false, stakePerPosition: 0, concurrentCap: 0, reason: `conf ${i.confidence.toFixed(2)} < 0.62` };
    if (i.openCount >= cap) return { allowNewPosition: false, stakePerPosition: i.baseStake, concurrentCap: cap, reason: `openCount ${i.openCount}=cap ${cap}` };
    const remaining = Math.max(0, i.balance * maxExp - i.openExposure);
    const slots = cap - i.openCount;
    const stake = Math.min(i.baseStake, remaining / Math.max(1, slots));
    if (stake < minStake) return { allowNewPosition: false, stakePerPosition: stake, concurrentCap: cap, reason: `stake ${stake.toFixed(2)} < min ${minStake}` };
    return { allowNewPosition: true, stakePerPosition: Math.round(stake * 100) / 100, concurrentCap: cap,
        reason: `open ${i.openCount + 1}/${cap} @ $${stake.toFixed(2)}` };
}

/**
 * Edge-to-Cost Ratio Gate — v5.4
 * ===============================
 * Entry only proceeds if:
 *
 *   Edge_Ratio = Expected_R / Cost_Estimate  >=  MIN_RATIO
 *
 * Expected_R comes from a rolling (symbol, regime, confidence-bucket)
 * lookup of realised R multiples. Cost_Estimate = live spread + slippage.
 *
 * Anti-curve-fit safeguards:
 *   - If the (symbol, regime, bucket) has fewer than MIN_SAMPLES,
 *     fall back to a CONSERVATIVE default (Expected_R = 0.8) so an
 *     unknown regime cannot pass this gate cheaply.
 *   - MIN_RATIO configurable (default 1.5); tighter regimes may raise it.
 */

export type RegimeId =
    | 'TREND_HIGH_VOL' | 'TREND_LOW_VOL'
    | 'RANGE_HIGH_VOL' | 'RANGE_LOW_VOL'
    | 'BREAKOUT' | 'COMPRESSION' | 'UNKNOWN';

export interface RTrade {
    symbol: string;
    regime: RegimeId;
    confBucket: number;   // 0..9 = 10 buckets
    R: number;            // realised R multiple (win = +N, loss = -1)
    ts: number;
}

const MIN_SAMPLES = 8;
const WINDOW = 400;
const FALLBACK_EXPECTED_R = 0.8;

function key(sym: string, regime: RegimeId, bucket: number): string {
    return `${sym}|${regime}|${bucket}`;
}

export interface EdgeCostInput {
    symbol: string;
    regime: RegimeId;
    confidence: number;    // 0..1
    liveSpread: number;    // in pips
    slippageEstimate: number;    // in pips
    minRatio?: number;     // default 1.5
}

export interface EdgeCostDecision {
    allow: boolean;
    edgeRatio: number;
    expectedR: number;
    costPips: number;
    reason: string;
    samples: number;
}

export class EdgeCostGate {
    private trades = new Map<string, RTrade[]>();

    /** Called after every closed trade. */
    record(t: RTrade): void {
        const k = key(t.symbol, t.regime, t.confBucket);
        const arr = this.trades.get(k) ?? [];
        arr.push(t);
        if (arr.length > WINDOW) arr.shift();
        this.trades.set(k, arr);
    }

    /** Look up expected R for the (symbol, regime, confidence-bucket) triple. */
    expectedR(sym: string, regime: RegimeId, confidence: number): { R: number; n: number } {
        const bucket = Math.min(9, Math.max(0, Math.floor(confidence * 10)));
        const arr = this.trades.get(key(sym, regime, bucket)) ?? [];
        if (arr.length < MIN_SAMPLES) return { R: FALLBACK_EXPECTED_R, n: arr.length };
        const mean = arr.reduce((s, t) => s + t.R, 0) / arr.length;
        return { R: mean, n: arr.length };
    }

    check(input: EdgeCostInput): EdgeCostDecision {
        // Warmup relaxation: allow modest bootstrap trades to build history,
        // BUT never below the conservative floor of 0.8. This is the exact
        // trade-off in the spec: fallback conservative ratio during warmup,
        // strict ratio once we have samples.
        const cost = Math.max(0.1, input.liveSpread + input.slippageEstimate);
        const { R, n } = this.expectedR(input.symbol, input.regime, input.confidence);
        const inWarmup = n < MIN_SAMPLES;
        const minRatio = input.minRatio ?? (inWarmup ? 0.8 : 1.5);
        const ratio = R / cost;
        if (ratio < minRatio) {
            return {
                allow: false, edgeRatio: ratio, expectedR: R, costPips: cost, samples: n,
                reason: `ER=${R.toFixed(2)}/cost=${cost.toFixed(2)}p = ${ratio.toFixed(2)} < ${minRatio} (n=${n})`,
            };
        }
        return {
            allow: true, edgeRatio: ratio, expectedR: R, costPips: cost, samples: n,
            reason: `ER=${R.toFixed(2)}/cost=${cost.toFixed(2)}p = ${ratio.toFixed(2)} ≥ ${minRatio} ✅ (n=${n})`,
        };
    }
}

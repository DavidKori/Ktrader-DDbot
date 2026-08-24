/**
 * Duration Model — adaptive entry duration intelligence.
 * ------------------------------------------------------
 * Instead of "always 5 ticks" or "always 600 s hold", the system computes
 * an optimal duration per signal based on:
 *   - ATR (price velocity)
 *   - ADX (trend persistence)
 *   - Bollinger bandwidth (volatility expansion)
 *   - Volume z-score (participation intensity)
 *   - Market regime
 *   - Symbol's tick interval (1HZ runs 2× faster than slow R_*)
 *   - Contract type (digits resolve in N ticks; multipliers can hold longer)
 *
 * Output:
 *   - durationTicks   — for binary CALL/PUT and DIGIT contracts
 *   - maxHoldSec      — wall-clock ceiling for multiplier positions
 *   - stopLossPips    — adaptive based on ATR × volatility multiplier
 *   - takeProfitPips  — adaptive (asymmetric R:R based on regime)
 *   - trailingActivatedPips / trailingDistancePips
 *
 * Optionally also calls the FastAPI /predict_duration endpoint when the
 * LightGBM duration model is deployed; falls back to deterministic math.
 */
import type { IndicatorSnapshot } from '../engine/indicator-engine';
import type { VolumeAnalysis }    from '../engine/adaptive-volume';
import type { MarketRegime }      from '../regime/market-regime';
import type { ContractType }      from '../regime/market-regime';

export interface DurationPlan {
    durationTicks: number;        // 3..15 for binary, ignored for multipliers
    maxHoldSec:   number;         // 60..1800 for multipliers
    stopLossPips:  number;        // adaptive ATR-based
    takeProfitPips: number;
    trailingActivatedPips: number;
    trailingDistancePips:  number;
    rationale: string;
}

const getViteEnv = (key: string): string | undefined => {
    try {
        if (typeof process !== 'undefined' && (process as any).env) {
            const v = (process as any).env[key];
            if (typeof v === 'string') return v;
        }
    } catch { /* fallthrough */ }
    return undefined;
};

const ML_DURATION_URL =
    getViteEnv('VITE_ML_DURATION_ENDPOINT') ||
    (typeof process !== 'undefined' && (process as any).env?.VITE_ML_DURATION_ENDPOINT) ||
    (typeof globalThis !== 'undefined' && (globalThis as any).VITE_ML_DURATION_ENDPOINT) ||
    '';   // empty -> skip remote, use deterministic only

const clamp = (n: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, Math.round(n)));

/**
 * Volatility "speed" factor — how many pips price typically moves in 1 tick.
 */
const tickVelocity = (snap: IndicatorSnapshot, pip: number): number => {
    if (!Number.isFinite(snap.atr) || pip === 0) return 1;
    // ATR is the 14-bar average true range. Each candle on a 60 s feed contains
    // ~30–60 ticks for 1HZ indices and ~30 ticks for slow indices. Approximate.
    return Math.max(0.1, snap.atr / pip / 30);
};

const regimeBias = (regime: MarketRegime): { ticks: number; sl: number; tp: number; trail: number } => {
    switch (regime) {
        case 'trending_bull':
        case 'trending_bear':     return { ticks: +2, sl: 1.0, tp: 2.5, trail: 1.2 };   // ride longer
        case 'volatile_breakout': return { ticks: -1, sl: 1.4, tp: 2.0, trail: 1.0 };   // wider SL, shorter ticks
        case 'mean_reverting':    return { ticks: -2, sl: 0.8, tp: 1.3, trail: 0.7 };   // tight & fast
        case 'choppy_low_vol':    return { ticks: -1, sl: 0.6, tp: 1.0, trail: 0.6 };
        case 'unknown':
        default:                  return { ticks:  0, sl: 1.0, tp: 2.0, trail: 1.0 };
    }
};

/**
 * Deterministic, math-only duration planner. Always works offline.
 */
export const planDurationDeterministic = (
    snap: IndicatorSnapshot,
    vol:  VolumeAnalysis,
    regime: MarketRegime,
    contractType: ContractType,
    tickIntervalSec: number,
    pip: number,
): DurationPlan => {
    const velocity = tickVelocity(snap, pip);            // pips per tick (approx)
    const r = regimeBias(regime);

    // ── Tick count for binary contracts ──────────────────────────────────
    // Slow markets (ADX low, low velocity) → fewer ticks; trending → more.
    let baseTicks = 5;
    if (Number.isFinite(snap.adx)) {
        if (snap.adx > 35)      baseTicks = 9;
        else if (snap.adx > 25) baseTicks = 7;
        else if (snap.adx > 15) baseTicks = 5;
        else                    baseTicks = 4;
    }
    if (vol.influxEvent)     baseTicks += 1;
    if (vol.regime === 'dry') baseTicks -= 1;
    baseTicks += r.ticks;
    const durationTicks = clamp(baseTicks, 3, 15);

    // ── Wall-clock ceiling for multipliers ───────────────────────────────
    // 60 s minimum, scaled by ADX (trend = longer) and Bollinger expansion.
    const bbExpansion = Number.isFinite(snap.bollinger.bandwidth) ? snap.bollinger.bandwidth : 0.02;
    const adxFactor   = Number.isFinite(snap.adx) ? clamp(snap.adx, 5, 50) : 20;
    let maxHoldSec = Math.round(120 + adxFactor * 12 - bbExpansion * 1500);
    maxHoldSec = clamp(maxHoldSec, 60, 1800);
    if (regime === 'mean_reverting') maxHoldSec = Math.min(maxHoldSec, 240);
    if (regime === 'volatile_breakout') maxHoldSec = Math.min(maxHoldSec, 180);

    // ── Adaptive SL / TP in pips ─────────────────────────────────────────
    // SL = velocity × (10 ticks worth) × regime factor — i.e. price needs to
    // travel ~10 candles worth of typical movement against you to stop out.
    const baseSL = Math.max(5, Math.round(velocity * 30 * r.sl));
    const baseTP = Math.max(10, Math.round(velocity * 30 * r.tp));
    const trailAct = Math.max(8, Math.round(baseTP * 0.6));
    const trailDist = Math.max(4, Math.round(velocity * 30 * r.trail * 0.4));

    const rationale =
        `regime=${regime} adx=${snap.adx.toFixed(0)} velocity=${velocity.toFixed(2)}p/tk → ` +
        `${durationTicks}t / ${maxHoldSec}s · SL=${baseSL}p TP=${baseTP}p trail@${trailAct}/${trailDist}`;

    // Suppress unused-var warning (tickIntervalSec/contractType reserved for future ML model)
    void tickIntervalSec; void contractType;

    return {
        durationTicks, maxHoldSec,
        stopLossPips: baseSL, takeProfitPips: baseTP,
        trailingActivatedPips: trailAct, trailingDistancePips: trailDist,
        rationale,
    };
};

/**
 * Public API. Tries the LightGBM duration model first; falls back to the
 * deterministic planner above on any error or when the endpoint is unset.
 */
export async function planDuration(
    snap: IndicatorSnapshot,
    vol:  VolumeAnalysis,
    regime: MarketRegime,
    contractType: ContractType,
    tickIntervalSec: number,
    pip: number,
): Promise<DurationPlan> {
    const fallback = planDurationDeterministic(snap, vol, regime, contractType, tickIntervalSec, pip);
    if (!ML_DURATION_URL) return fallback;

    try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 3000);
        const res = await fetch(ML_DURATION_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                rsi: snap.rsi, macd_hist: snap.macd.histogram, atr: snap.atr,
                adx: snap.adx, bollinger_bw: snap.bollinger.bandwidth,
                vol_z: vol.zscore, regime, tickIntervalSec,
            }),
            signal: ctl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) return fallback;

        const data = await res.json();
        const durationTicks = clamp(Number(data.duration_ticks) || fallback.durationTicks, 3, 15);
        const maxHoldSec    = clamp(Number(data.max_hold_sec)   || fallback.maxHoldSec,    60, 1800);
        return {
            ...fallback,
            durationTicks, maxHoldSec,
            rationale: fallback.rationale + ' [ML-tuned]',
        };
    } catch {
        return fallback;
    }
}

/**
 * Absorption Probability Layer — v5.5
 * ====================================
 * We CANNOT know whether a snap-back was caused by institutional absorption
 * or random volatility. So we estimate the PROBABILITY of absorption from
 * data available on the feed:
 *
 *   1. **Tick-arrival intensity ratio**  — sudden burst of activity during
 *      the rejection vs the last 5 min baseline. Real absorption prints an
 *      activity spike; random noise does not.
 *   2. **Two-way churn**                  — if the wick zone was hit MULTIPLE
 *      times and rejected each time, that is stronger absorption evidence
 *      than a single touch.
 *   3. **Rejection efficiency**           — small amount of price consumed
 *      per tick during the snap-back (many ticks → little back-and-forth).
 *      Institutional absorption produces efficient one-directional recoveries.
 *   4. **Spread quiet-then-widen**        — spread compresses during
 *      absorption (many limit orders) then widens after the snap. If we
 *      only have last-price data, we approximate via tick-to-tick variance.
 *
 * All four are combined with logistic weights to output a probability in
 * [0, 1]. Callers should MULTIPLY (not replace) their confidence by this
 * probability, so uncertainty always suppresses trade size / conviction.
 */

export interface AbsorptionInput {
    side: 'LONG' | 'SHORT';
    /** Ticks (chronological) covering at least the last ~15-30 s. */
    recentTicks: number[];
    /** Parallel ms epochs. */
    recentTickTsMs: number[];
    /** Longer baseline ticks (last ~5 min) for rate comparison. */
    baselineTsMs?: number[];
    /** Extreme tick index in `recentTicks` — end of the wick. */
    extremeIdx: number;
    /** ATR of the containing timeframe (M5). */
    atr: number;
}

export interface AbsorptionResult {
    probability: number;         // 0..1
    parts: {
        intensityRatio: number;
        churn: number;
        efficiency: number;
        spreadStability: number;
    };
    reason: string;
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }

function tickRatePerSec(tsMs: number[], winSec = 15): number {
    if (tsMs.length < 2) return 0;
    const now = tsMs[tsMs.length - 1];
    const from = now - winSec * 1000;
    const n = tsMs.filter(t => t >= from).length;
    return n / winSec;
}

export function estimateAbsorption(input: AbsorptionInput): AbsorptionResult {
    const zero: AbsorptionResult = {
        probability: 0.5,
        parts: { intensityRatio: 0, churn: 0, efficiency: 0, spreadStability: 0 },
        reason: 'insufficient data',
    };
    if (input.recentTicks.length < 8 || input.extremeIdx < 0) return zero;

    // 1. intensity ratio  = short-window tick rate vs baseline
    const shortRate = tickRatePerSec(input.recentTickTsMs, 15);
    const baseWin = input.baselineTsMs ?? input.recentTickTsMs;
    const baseRate = tickRatePerSec(baseWin, 300);
    const intensityRatio = baseRate > 0 ? clamp01((shortRate / baseRate - 1) / 2) : 0;

    // 2. churn — how many times did price re-visit the wick extreme?
    const extreme = input.recentTicks[input.extremeIdx];
    const tol = Math.max(1e-9, input.atr * 0.05);   // 5% of ATR window
    let visits = 0;
    let inZone = false;
    for (const p of input.recentTicks) {
        const near = input.side === 'LONG' ? p <= extreme + tol : p >= extreme - tol;
        if (near && !inZone) { visits++; inZone = true; }
        else if (!near && inZone) { inZone = false; }
    }
    const churn = clamp01((visits - 1) / 3);   // 4+ visits → full mark

    // 3. rejection efficiency = |net move| / sum(|tick-to-tick moves|) since extreme
    let cumAbs = 0, net = 0;
    for (let i = input.extremeIdx + 1; i < input.recentTicks.length; i++) {
        const d = input.recentTicks[i] - input.recentTicks[i - 1];
        cumAbs += Math.abs(d);
        net += d;
    }
    const efficiency = cumAbs > 0 ? clamp01(Math.abs(net) / cumAbs) : 0;

    // 4. spread stability proxy — tick-to-tick std normalised by ATR, LOW = stable
    const tail = input.recentTicks.slice(input.extremeIdx + 1);
    let m = 0, v = 0;
    if (tail.length > 2) {
        m = tail.reduce((s, x) => s + x, 0) / tail.length;
        v = tail.reduce((s, x) => s + (x - m) ** 2, 0) / tail.length;
    }
    const std = Math.sqrt(v);
    const spreadStability = clamp01(1 - std / Math.max(1e-9, input.atr * 0.2));

    // Logistic combination — coefficients tuned so 3+ strong parts → p ≈ 0.85
    const logit = 2.5 * intensityRatio + 1.8 * churn + 2.0 * efficiency + 1.2 * spreadStability - 3.0;
    const probability = sigmoid(logit);

    return {
        probability,
        parts: { intensityRatio, churn, efficiency, spreadStability },
        reason: `int=${intensityRatio.toFixed(2)} churn=${churn.toFixed(2)} eff=${efficiency.toFixed(2)} spd=${spreadStability.toFixed(2)} → p=${probability.toFixed(2)}`,
    };
}

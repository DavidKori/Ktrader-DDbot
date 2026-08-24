/**
 * Digit Statistics Engine
 * -----------------------
 * Required for binary DIGITMATCH / DIGITDIFF / DIGITOVER / DIGITUNDER contracts on
 * volatility indices. Computes last-digit distribution from a tick history and
 * returns positive edge-expectancy targets.
 *
 * The "edge" is computed against the payout breakeven (1 / payout_multiple).
 * Returning a digit/threshold only when the observed frequency exceeds breakeven
 * by `safetyBuffer` enforces positive expected value.
 */
export interface DigitDistribution {
    counts: number[];   // length 10
    freq:   number[];   // length 10, sums to 1
    samples: number;
}

export const lastDigit = (price: number, decimals = 2): number => {
    // Multiply to bring the rightmost meaningful digit into integer position.
    const scaled = Math.round(price * Math.pow(10, decimals));
    return Math.abs(scaled) % 10;
};

export const buildDigitDistribution = (
    ticks: number[], decimals = 2, window = 500,
): DigitDistribution => {
    const sliced = ticks.slice(-window);
    const counts = new Array<number>(10).fill(0);
    for (const t of sliced) counts[lastDigit(t, decimals)]++;
    const n = sliced.length || 1;
    return { counts, freq: counts.map(c => c / n), samples: n };
};

/**
 * Returns the digit with the **highest** observed frequency, but only if the
 * observed frequency clears the breakeven threshold by `safetyBuffer`.
 * Otherwise returns null — meaning no positive-EV digit-match exists.
 */
export const bestMatchDigit = (
    dist: DigitDistribution, payoutMultiple = 9.0, safetyBuffer = 0.015,
): { digit: number; edge: number } | null => {
    const breakeven = 1 / payoutMultiple;            // ~0.111 for typical 9x payout
    let best = -1, bestFreq = -Infinity;
    for (let d = 0; d < 10; d++) {
        if (dist.freq[d] > bestFreq) { bestFreq = dist.freq[d]; best = d; }
    }
    const edge = bestFreq - breakeven;
    return edge > safetyBuffer ? { digit: best, edge } : null;
};

/**
 * Returns the digit with the **lowest** observed frequency for DIGITDIFF,
 * but only if betting "differ" is profitable (frequency × (payout-1) − (1−freq) > buffer).
 * For DIGITDIFF payout ~1.07 typically: very hard to find edge — usually null.
 */
export const bestDifferDigit = (
    dist: DigitDistribution, payoutMultiple = 1.07, safetyBuffer = 0.005,
): { digit: number; edge: number } | null => {
    let worst = -1, worstFreq = Infinity;
    for (let d = 0; d < 10; d++) {
        if (dist.freq[d] < worstFreq) { worstFreq = dist.freq[d]; worst = d; }
    }
    // For DIFFER: win prob = 1 - p(digit), payout = payoutMultiple
    const winProb = 1 - worstFreq;
    const ev = winProb * (payoutMultiple - 1) - worstFreq;
    return ev > safetyBuffer ? { digit: worst, edge: ev } : null;
};

/**
 * Over edge — frequency of digits >= barrier vs breakeven.
 */
export const overEdge = (
    dist: DigitDistribution, barrier: number,
    payoutMultiple = 1.95, safetyBuffer = 0.015,
): number => {
    const obs = dist.freq.slice(barrier + 1, 10).reduce((a, b) => a + b, 0);
    const breakeven = 1 / payoutMultiple;
    return obs - breakeven - safetyBuffer;
};

/**
 * Under edge — frequency of digits < barrier vs breakeven.
 */
export const underEdge = (
    dist: DigitDistribution, barrier: number,
    payoutMultiple = 1.95, safetyBuffer = 0.015,
): number => {
    const obs = dist.freq.slice(0, barrier).reduce((a, b) => a + b, 0);
    const breakeven = 1 / payoutMultiple;
    return obs - breakeven - safetyBuffer;
};

/**
 * Convenience: scan all barriers 1..8 and return the best Over/Under combo
 * with **positive EV after safety buffer** — or null.
 *
 * Bug fix (v5 final): previous version called overEdge/underEdge with
 * safetyBuffer=0, which made a uniform distribution falsely show edge for
 * extreme barriers (e.g. OVER 1 has 80% observed vs 51% breakeven, but that
 * "edge" comes from the math of the barrier, not from a real bias). The
 * safety buffer must be threaded through so uniform/random distributions
 * correctly return null.
 */
export const bestOverUnder = (
    dist: DigitDistribution, payoutMultiple = 1.95, safetyBuffer = 0.015,
): { side: 'OVER' | 'UNDER'; barrier: number; edge: number } | null => {
    let best: { side: 'OVER' | 'UNDER'; barrier: number; edge: number } | null = null;
    const breakeven = 1 / payoutMultiple;
    for (let b = 1; b <= 8; b++) {
        // overEdge/underEdge already subtract breakeven + safetyBuffer internally;
        // we additionally require the *bias above the natural barrier ratio* to be
        // positive — i.e. an actual skew, not just a payout-window artifact.
        const obsOver  = dist.freq.slice(b + 1, 10).reduce((a, x) => a + x, 0);
        const obsUnder = dist.freq.slice(0, b).reduce((a, x) => a + x, 0);

        // Expected share of digits in each window on a uniform distribution.
        const expOver  = (9 - b) / 10;   // digits b+1..9
        const expUnder = b / 10;          // digits 0..b-1

        const oBias = obsOver  - expOver;    // positive = skew toward high digits
        const uBias = obsUnder - expUnder;   // positive = skew toward low  digits

        const oEv = obsOver  - breakeven - safetyBuffer;
        const uEv = obsUnder - breakeven - safetyBuffer;

        if (oEv > 0 && oBias > safetyBuffer && (!best || oEv > best.edge)) {
            best = { side: 'OVER',  barrier: b, edge: oEv };
        }
        if (uEv > 0 && uBias > safetyBuffer && (!best || uEv > best.edge)) {
            best = { side: 'UNDER', barrier: b, edge: uEv };
        }
    }
    return best;
};

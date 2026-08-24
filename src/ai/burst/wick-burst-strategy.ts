/**
 * Wick-Burst Scalping Strategy — v5.4
 * ====================================
 * 5-minute candle system with INTRABAR execution:
 *   - Wicks = entry trigger zones (liquidity sweep)
 *   - Body  = profit realisation zone
 *
 * Entries fire on wick INTERACTION (tap + reject), not body confirmation.
 * Partial profit is taken when the candle body forms in trade direction,
 * remainder rides via trailing stop.
 *
 * CAUSALITY CONSTRAINT (spec §):
 *   Any calculation at time t uses ONLY data available up to t. No
 *   forward-looking references to the current bar's close/high/low.
 *   This constraint is enforced identically here in live and backtest —
 *   we accept a partial-bar snapshot and label the fields for auditability.
 */

export interface BarSnapshot {
    /** Ms since epoch — evaluation time. */
    tsMs: number;
    /** Open price of the CURRENT 5-min bar. */
    open: number;
    /** Highest price seen SO FAR in the current bar (up to tsMs). */
    highSoFar: number;
    /** Lowest price seen SO FAR in the current bar (up to tsMs). */
    lowSoFar: number;
    /** Latest tick price. */
    lastPrice: number;
    /** Ms elapsed since bar open (0..300 000). */
    elapsedMs: number;
    /** Closed prior 5-min bars, chronological. */
    priorBars: { open: number; high: number; low: number; close: number; volume: number }[];
    /** Recent tick prices (last few seconds) to test rejection. */
    recentTicks: number[];
    /** Recent tick timestamps. */
    recentTickTsMs: number[];
}

export interface WickBurstConfig {
    /** Wick depth as a multiple of the recent M5 ATR: how far below the OPEN counts as a "tap". */
    wickAtrDepth: number;
    /** Rejection: how fast (in ms) the price must snap back off the wick. */
    rejectionSnapMs: number;
    /** How far (in ATR-normalised units) the snap-back must travel. */
    rejectionAtrMove: number;
    /** Partial-profit threshold: fraction of ATR that body must have formed in direction. */
    partialProfitAtr: number;
    /** Partial-close fraction of position (0.30..0.70). */
    partialCloseFrac: number;
}

export const DEFAULT_WICK_BURST_CFG: WickBurstConfig = {
    wickAtrDepth: 0.35,
    rejectionSnapMs: 6000,
    rejectionAtrMove: 0.20,
    partialProfitAtr: 0.30,
    partialCloseFrac: 0.50,
};

export interface WickBurstDecision {
    signal: 'LONG' | 'SHORT' | 'NONE';
    reason: string;
    wickDepthAtr: number;
    rejectionAtr: number;
    confidence: number;    // 0..1
    partialTrigger: boolean;
}

function atrM5(bars: { high: number; low: number; close: number }[], n = 14): number {
    if (bars.length < n + 1) return NaN;
    const trs: number[] = [];
    for (let i = bars.length - n; i < bars.length; i++) {
        const c = bars[i], p = bars[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return trs.reduce((a, b) => a + b, 0) / n;
}

/**
 * Detect wick-tap + rejection on the current bar. Returns a signal only
 * if BOTH conditions hold using only prior-bar data + this bar's snapshot
 * SO FAR — no reference to end-of-bar values.
 */
export function evaluateWickBurst(
    snap: BarSnapshot,
    cfg: WickBurstConfig = DEFAULT_WICK_BURST_CFG,
): WickBurstDecision {
    const atr = atrM5(snap.priorBars);
    if (!isFinite(atr) || atr <= 0) {
        return { signal: 'NONE', reason: 'warmup', wickDepthAtr: 0, rejectionAtr: 0, confidence: 0, partialTrigger: false };
    }
    // Compute wick depths using ONLY the SO_FAR extremes
    const lowerWick = snap.open - snap.lowSoFar;    // positive if price went below open
    const upperWick = snap.highSoFar - snap.open;   // positive if price went above open
    const lowerWickAtr = lowerWick / atr;
    const upperWickAtr = upperWick / atr;

    // Rejection: over the last `rejectionSnapMs`, price must have moved
    // by rejectionAtrMove × ATR in the opposite direction of the wick.
    const cutoff = snap.tsMs - cfg.rejectionSnapMs;
    let recentMinIdx = -1, recentMaxIdx = -1;
    let recentMin = +Infinity, recentMax = -Infinity;
    for (let i = 0; i < snap.recentTicks.length; i++) {
        if (snap.recentTickTsMs[i] < cutoff) continue;
        if (snap.recentTicks[i] < recentMin) { recentMin = snap.recentTicks[i]; recentMinIdx = i; }
        if (snap.recentTicks[i] > recentMax) { recentMax = snap.recentTicks[i]; recentMaxIdx = i; }
    }
    // LONG: lower wick tapped, then snap UP
    if (lowerWickAtr >= cfg.wickAtrDepth && recentMinIdx >= 0 && recentMaxIdx > recentMinIdx) {
        const rejMove = (snap.lastPrice - recentMin) / atr;
        if (rejMove >= cfg.rejectionAtrMove) {
            const conf = Math.min(1, 0.5 * (lowerWickAtr / cfg.wickAtrDepth) + 0.5 * (rejMove / cfg.rejectionAtrMove));
            const bodyDir = (snap.lastPrice - snap.open) / atr;
            const partial = bodyDir >= cfg.partialProfitAtr;
            return { signal: 'LONG', reason: `lower wick ${lowerWickAtr.toFixed(2)}ATR + snap ${rejMove.toFixed(2)}ATR`, wickDepthAtr: lowerWickAtr, rejectionAtr: rejMove, confidence: conf, partialTrigger: partial };
        }
    }
    // SHORT: upper wick tapped, then snap DOWN
    if (upperWickAtr >= cfg.wickAtrDepth && recentMaxIdx >= 0 && recentMinIdx > recentMaxIdx) {
        const rejMove = (recentMax - snap.lastPrice) / atr;
        if (rejMove >= cfg.rejectionAtrMove) {
            const conf = Math.min(1, 0.5 * (upperWickAtr / cfg.wickAtrDepth) + 0.5 * (rejMove / cfg.rejectionAtrMove));
            const bodyDir = (snap.open - snap.lastPrice) / atr;
            const partial = bodyDir >= cfg.partialProfitAtr;
            return { signal: 'SHORT', reason: `upper wick ${upperWickAtr.toFixed(2)}ATR + snap ${rejMove.toFixed(2)}ATR`, wickDepthAtr: upperWickAtr, rejectionAtr: rejMove, confidence: conf, partialTrigger: partial };
        }
    }
    return { signal: 'NONE', reason: 'no wick+rejection', wickDepthAtr: Math.max(lowerWickAtr, upperWickAtr), rejectionAtr: 0, confidence: 0, partialTrigger: false };
}

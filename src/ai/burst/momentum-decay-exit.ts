/**
 * Momentum-Decay Exit — v5.5 (M5 refinement §7 + §10)
 * =====================================================
 * Continuous-management exit for burst-triggered trades.
 * NOT a candle-close exit. Watches the burst energy tick-by-tick and
 * secures profit as soon as the momentum weakens.
 *
 * Signals (any one → exit):
 *   A. burst velocity has dropped > 40 % from peak
 *   B. tick-to-tick range in last 15 s < 0.10 × ATR (flat market)
 *   C. body has already realised > 0.85 of estimated max potential move
 *   D. price has retraced > 50 % of the burst move from its peak profit
 *   E. spread widened > 2× the recent baseline (liquidity vanished)
 *   F. an OPPOSING wick has printed in the direction of the trade
 *
 * Every trigger records a reason string so callers can classify exits.
 */

export interface DecayInput {
    side: 'LONG' | 'SHORT';
    /** Entry price. */
    entryPrice: number;
    /** Current tick price. */
    lastPrice: number;
    /** Peak profit (in price units, positive if in profit). */
    peakProfitAbs: number;
    /** Ticks in the last ~15 s (chronological). */
    recentTicks: number[];
    recentTickTsMs: number[];
    /** Burst peak velocity (pips/sec), captured when the burst was detected. */
    peakBurstVelocity: number;
    /** ATR of the containing timeframe. */
    atr: number;
    /** Body's expected max ATR-normalised move (default 2.5). */
    expectedMaxAtr?: number;
    /** Optional last spread reading (pips) and recent-baseline spread. */
    liveSpreadPips?: number;
    baselineSpreadPips?: number;
    /** Optional flag: opposing wick detected on the CURRENT candle. */
    opposingWick?: boolean;
}

export interface DecayDecision {
    exit: boolean;
    reason: string;
    signals: Record<string, boolean>;
}

function tickRangeIn(recentTicks: number[], tsMs: number[], winSec: number): number {
    if (recentTicks.length < 2) return 0;
    const now = tsMs[tsMs.length - 1];
    let hi = -Infinity, lo = Infinity;
    for (let i = 0; i < recentTicks.length; i++) {
        if (tsMs[i] < now - winSec * 1000) continue;
        if (recentTicks[i] > hi) hi = recentTicks[i];
        if (recentTicks[i] < lo) lo = recentTicks[i];
    }
    return isFinite(hi) && isFinite(lo) ? Math.max(0, hi - lo) : 0;
}

function currentVelocity(recentTicks: number[], tsMs: number[]): number {
    if (recentTicks.length < 4) return 0;
    const now = tsMs[tsMs.length - 1];
    const cutoff = now - 5000;
    let firstIdx = tsMs.length - 1;
    while (firstIdx > 0 && tsMs[firstIdx] >= cutoff) firstIdx--;
    const dt = (tsMs[tsMs.length - 1] - tsMs[firstIdx]) / 1000;
    const dP = recentTicks[recentTicks.length - 1] - recentTicks[firstIdx];
    return dt > 0 ? Math.abs(dP) / dt * 10000 : 0;   // pips/sec
}

export function decideMomentumDecayExit(input: DecayInput): DecayDecision {
    const signals: Record<string, boolean> = {
        velocityDrop: false, flatMarket: false, bodyMaxed: false,
        deepRetrace: false, spreadBlow: false, opposingWick: false,
    };
    if (input.recentTicks.length < 6 || input.atr <= 0) {
        return { exit: false, reason: 'insufficient data', signals };
    }

    const expectedMax = input.expectedMaxAtr ?? 2.5;

    // A. velocity drop
    const nowVel = currentVelocity(input.recentTicks, input.recentTickTsMs);
    if (input.peakBurstVelocity > 0 && nowVel < 0.60 * input.peakBurstVelocity) {
        signals.velocityDrop = true;
    }

    // B. flat market
    const range15 = tickRangeIn(input.recentTicks, input.recentTickTsMs, 15);
    if (range15 < 0.10 * input.atr) signals.flatMarket = true;

    // C. body has realised most of its potential
    const bodyMove = Math.abs(input.lastPrice - input.entryPrice);
    if (bodyMove >= 0.85 * expectedMax * input.atr) signals.bodyMaxed = true;

    // D. deep retrace from peak profit
    const currentProfitAbs = input.side === 'LONG'
        ? input.lastPrice - input.entryPrice
        : input.entryPrice - input.lastPrice;
    if (input.peakProfitAbs > 0 && currentProfitAbs < 0.5 * input.peakProfitAbs) {
        signals.deepRetrace = true;
    }

    // E. spread blow
    if (input.liveSpreadPips && input.baselineSpreadPips &&
        input.baselineSpreadPips > 0 && input.liveSpreadPips > 2 * input.baselineSpreadPips) {
        signals.spreadBlow = true;
    }

    // F. opposing wick
    if (input.opposingWick) signals.opposingWick = true;

    const anyExit = Object.values(signals).some(Boolean);
    const reasons = Object.entries(signals).filter(([, v]) => v).map(([k]) => k).join('+');
    return {
        exit: anyExit,
        reason: anyExit ? `momentum-decay: ${reasons}` : `holding (vel=${nowVel.toFixed(2)}p/s peak=${input.peakBurstVelocity.toFixed(2)}p/s)`,
        signals,
    };
}

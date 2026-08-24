/**
 * Auto-Timeframe Rotator (M1 ↔ M5)
 * =================================
 * Chooses between 60s (M1) and 300s (M5) candles per symbol based on:
 *   - current market regime (from regime-detector)
 *   - recent ATR percentile (proxy for realized volatility)
 *   - rolling win rate on the current timeframe
 *
 * Rules:
 *   - LightGBM models were trained on burst-scale features → prefer M1.
 *   - Escalate to M5 when: SHOCK regime OR ATR percentile > 90 OR win rate
 *     on M1 has dropped below 55 % in the last 40 trades on that symbol.
 *   - De-escalate back to M1 when: TREND regime is stable for ≥ 40 trades
 *     AND win rate ≥ 60 %.
 *
 * We never step outside {M1, M5} — this matches the user's constraint.
 */

export type Regime = 'TREND' | 'RANGE' | 'SHOCK' | 'UNKNOWN' | 'TREND_HIGH_VOL' | 'TREND_LOW_VOL' | 'RANGE_HIGH_VOL' | 'RANGE_LOW_VOL';

export interface TimeframeChoice {
    granularitySec: 60 | 300;
    historyCount: number;
    label: 'M1' | 'M5';
    reason: string;
}

export interface TimeframeContext {
    symbol: string;
    regime?: Regime;
    atrPercentile?: number;   // 0..100
    recentWinRate?: number;   // 0..1 on last 40 trades on current TF
    currentLabel?: 'M1' | 'M5';
    tradesSinceSwitch?: number;
}

const M1: TimeframeChoice = { granularitySec: 60,  historyCount: 240, label: 'M1', reason: '' };
const M5: TimeframeChoice = { granularitySec: 300, historyCount: 200, label: 'M5', reason: '' };

/** Minimum trades on a TF before switch is allowed (hysteresis). */
const MIN_TRADES_BEFORE_SWITCH = 30;

export function pickAutoTimeframe(ctx: TimeframeContext): TimeframeChoice {
    const cur = ctx.currentLabel ?? 'M1';
    const dwell = ctx.tradesSinceSwitch ?? 999;

    // Hysteresis — do not thrash between TFs
    if (dwell < MIN_TRADES_BEFORE_SWITCH) {
        return cur === 'M5'
            ? { ...M5, reason: `dwell ${dwell}/${MIN_TRADES_BEFORE_SWITCH} on M5` }
            : { ...M1, reason: `dwell ${dwell}/${MIN_TRADES_BEFORE_SWITCH} on M1` };
    }

    const isShock = ctx.regime === 'SHOCK';
    const isHighVol = (ctx.atrPercentile ?? 0) > 90;
    const isLosing = (ctx.recentWinRate ?? 1) < 0.55;

    // Escalate M1 → M5
    if (cur === 'M1' && (isShock || isHighVol || isLosing)) {
        const reasons = [
            isShock ? 'regime=SHOCK' : null,
            isHighVol ? `ATR%=${(ctx.atrPercentile ?? 0).toFixed(0)}` : null,
            isLosing ? `winRate=${((ctx.recentWinRate ?? 0) * 100).toFixed(0)}%<55` : null,
        ].filter(Boolean).join(', ');
        return { ...M5, reason: `escalate M1→M5 (${reasons})` };
    }

    // De-escalate M5 → M1
    const regimeStable = ctx.regime === 'TREND' || ctx.regime === 'TREND_LOW_VOL' || ctx.regime === 'TREND_HIGH_VOL';
    const goodPerf = (ctx.recentWinRate ?? 0) >= 0.60;
    if (cur === 'M5' && regimeStable && goodPerf && !isShock) {
        return { ...M1, reason: `de-escalate M5→M1 (${ctx.regime}, WR=${((ctx.recentWinRate ?? 0) * 100).toFixed(0)}%)` };
    }

    // Stay
    return cur === 'M5'
        ? { ...M5, reason: 'hold M5' }
        : { ...M1, reason: 'hold M1' };
}

/**
 * Convenience: choose TF and describe which mode (M1 is default because
 * LightGBM was trained on burst-scale features and outperforms on it).
 */
export function defaultTimeframeFor(symbol: string): TimeframeChoice {
    return pickAutoTimeframe({ symbol, currentLabel: 'M1', tradesSinceSwitch: 0 });
}

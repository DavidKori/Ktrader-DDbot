/**
 * Auto Exit Engine — LightGBM-only, adaptive parameters.
 * ------------------------------------------------------
 * 6 strategies in priority order. SL and TP are NEVER suppressed by the
 * premature-exit guard; the other four (vol spike / trailing / ML reversal /
 * time stagnation) only trigger AFTER `minSecondsHeld` has elapsed.
 *
 *   1. STOP_LOSS         (always)
 *   2. TAKE_PROFIT       (always)
 *   3. VOL_SPIKE         (guarded)
 *   4. TRAILING_STOP     (guarded)
 *   5. ML_REVERSAL       (guarded)
 *   6. TIME_STAGNATION   (guarded)
 */
import type { IndicatorSnapshot } from '../engine/indicator-engine';
import type { VolumeAnalysis }    from '../engine/adaptive-volume';
import type { MLPrediction }      from '../ml/lightgbm-client';

export type ExitReason =
    | 'STOP_LOSS' | 'TAKE_PROFIT' | 'VOL_SPIKE'
    | 'TRAILING_STOP' | 'ML_REVERSAL' | 'TIME_STAGNATION';

export interface ExitInputs {
    direction: 'UP' | 'DOWN' | 'NEUTRAL';
    entryPrice: number;
    currentPrice: number;
    pip: number;
    stopLossPips: number;
    takeProfitPips: number;
    trailingActivatedPips: number;
    trailingDistancePips: number;
    openedAt: number;
    maxHoldSec: number;
    minSecondsHeld?: number;         // premature-exit guard (default 0)
    snapshot: IndicatorSnapshot;
    volume: VolumeAnalysis;
    ml: MLPrediction;
    peakProfitPips: number;
}

export interface ExitDecision { shouldExit: boolean; reason?: ExitReason; detail?: string; }

const pipDiff = (entry: number, current: number, dir: 'UP' | 'DOWN' | 'NEUTRAL', pip: number) => {
    if (dir === 'NEUTRAL') return 0;
    const raw = (current - entry) / pip;
    return dir === 'UP' ? raw : -raw;
};

export const evaluateExit = (i: ExitInputs): ExitDecision => {
    const profitPips = pipDiff(i.entryPrice, i.currentPrice, i.direction, i.pip);
    const age = (Date.now() - i.openedAt) / 1000;
    const guard = i.minSecondsHeld ?? 0;
    const guardElapsed = age >= guard;

    // 1. SL — always
    if (profitPips <= -i.stopLossPips)
        return { shouldExit: true, reason: 'STOP_LOSS',
                 detail: `${profitPips.toFixed(1)} ≤ -${i.stopLossPips}` };

    // 2. TP — always
    if (profitPips >= i.takeProfitPips)
        return { shouldExit: true, reason: 'TAKE_PROFIT',
                 detail: `${profitPips.toFixed(1)} ≥ ${i.takeProfitPips}` };

    // 3. Vol spike — guarded
    if (guardElapsed) {
        const mlOpposes =
            (i.direction === 'UP'   && i.ml.direction_hint === 'SELL') ||
            (i.direction === 'DOWN' && i.ml.direction_hint === 'BUY');
        if (i.volume.zscore > 3 && mlOpposes) {
            return { shouldExit: true, reason: 'VOL_SPIKE',
                     detail: `z=${i.volume.zscore.toFixed(2)} + ML opposes` };
        }
    }

    // 4. Trailing stop — guarded
    if (guardElapsed &&
        i.peakProfitPips >= i.trailingActivatedPips &&
        profitPips < i.peakProfitPips - i.trailingDistancePips) {
        return { shouldExit: true, reason: 'TRAILING_STOP',
                 detail: `peak ${i.peakProfitPips.toFixed(1)} → now ${profitPips.toFixed(1)}` };
    }

    // 5. ML reversal — guarded, only while in profit
    if (guardElapsed) {
        const strongReversal =
            (i.direction === 'UP'   && i.ml.probability <= 0.30) ||
            (i.direction === 'DOWN' && i.ml.probability >= 0.70);
        if (strongReversal && profitPips > 0) {
            return { shouldExit: true, reason: 'ML_REVERSAL',
                     detail: `p=${i.ml.probability.toFixed(2)} opposes ${i.direction}` };
        }
    }

    // 6. Time stagnation — guarded, also needs maxHoldSec
    if (guardElapsed && age >= i.maxHoldSec &&
        Math.abs(profitPips) < i.takeProfitPips * 0.3) {
        return { shouldExit: true, reason: 'TIME_STAGNATION',
                 detail: `${age.toFixed(0)}s, profit ${profitPips.toFixed(1)} pips` };
    }
    return { shouldExit: false };
};

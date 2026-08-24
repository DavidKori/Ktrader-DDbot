/**
 * Multi-Layer Entry Gate — v5.2 (Priority 10)
 * --------------------------------------------
 * A small final-mile sanity check that runs AFTER the fusion + validation
 * engines have already produced their verdicts. It catches obvious red flags
 * the per-component scores can miss because each scores in isolation:
 *
 *   1. Trend alignment      — fusion direction must agree with EMA fast/slow
 *   2. Volume confirmation  — non-dry volume required
 *   3. Regime cleanliness   — not 'choppy_low_vol' / 'unknown'
 *   4. Indicator non-extreme — RSI not flat-lining at 0/100 (data error)
 *   5. ML conviction        — |p - 0.5| >= 0.10  (avoid coin-flip trades)
 *
 * Returns the first failure encountered so the UI can show a clear reason.
 */
import type { IndicatorSnapshot } from '../engine/indicator-engine';
import type { VolumeAnalysis }    from '../engine/adaptive-volume';
import type { MLPrediction }      from '../ml/lightgbm-client';
import type { MarketRegime }      from '../regime/market-regime';
import type { FusionResult }      from '../fusion/signal-fusion';

export interface MultiLayerInputs {
    snapshot:  IndicatorSnapshot;
    volume:    VolumeAnalysis;
    ml:        MLPrediction;
    regime:    MarketRegime;
    fusion:    FusionResult;
}

export interface MultiLayerVerdict {
    allowed: boolean;
    reason?: string;
}

const epsilon = 0.10;

export const checkMultiLayer = (i: MultiLayerInputs): MultiLayerVerdict => {
    const { snapshot: s, volume: v, ml, regime, fusion } = i;

    // 1. Trend alignment
    const emaBullish = s.ema_fast > s.ema_slow;
    if (fusion.direction === 'BUY'  && !emaBullish) {
        return { allowed: false, reason: 'BUY signal contradicts EMA trend (fast<slow)' };
    }
    if (fusion.direction === 'SELL' && emaBullish) {
        return { allowed: false, reason: 'SELL signal contradicts EMA trend (fast>slow)' };
    }

    // 2. Volume confirmation
    if (v.regime === 'dry') {
        return { allowed: false, reason: 'volume is dry — entries blocked' };
    }

    // 3. Regime cleanliness
    if (regime === 'choppy_low_vol' || regime === 'unknown') {
        return { allowed: false, reason: `regime ${regime} — entries blocked` };
    }

    // 4. RSI sanity
    if (!Number.isFinite(s.rsi) || s.rsi <= 0 || s.rsi >= 100) {
        return { allowed: false, reason: `RSI extreme/invalid (${s.rsi})` };
    }

    // 5. ML conviction
    if (Math.abs(ml.probability - 0.5) < epsilon) {
        return {
            allowed: false,
            reason: `ML coin-flip (p=${ml.probability.toFixed(2)} within ±${epsilon})`,
        };
    }

    return { allowed: true };
};

/**
 * Signal Fusion Engine — LightGBM-only.
 * --------------------------------------
 * Combines indicator confluence + volume regime + LightGBM probability.
 *
 * Weights:
 *
 *   RSI       +25
 *   MACD      +30
 *   Volume    +30
 *   LightGBM  +55
 *                ──── score → STRONG ≥ 100 · MEDIUM ≥ 75 · WEAK ≥ 50
 *
 * Confidence (0..1) = score / 150. The Execution Engine uses confidence
 * directly to choose between VIRTUAL / LIVE / LIVE_MARTINGALE modes.
 *
 * No chat-AI / LLM dependency — only the LightGBM booster contributes
 * machine-learning input to this fusion.
 */
import type { IndicatorSnapshot } from '../engine/indicator-engine';
import type { VolumeAnalysis }    from '../engine/adaptive-volume';
import type { MLPrediction }      from '../ml/lightgbm-client';

export type FusionDirection = 'BUY' | 'SELL' | 'NONE';
export type FusionStrength  = 'NONE' | 'WEAK' | 'MEDIUM' | 'STRONG';

export interface FusionResult {
    direction:  FusionDirection;
    strength:   FusionStrength;
    score:      number;
    rationale:  string[];
    confidence: number;
}

interface SideScore { buy: number; sell: number; }

export const fuseSignals = (
    snap: IndicatorSnapshot,
    vol:  VolumeAnalysis,
    ml:   MLPrediction,
): FusionResult => {
    const s: SideScore = { buy: 0, sell: 0 };
    const reasons: string[] = [];

    // RSI — +25
    if (Number.isFinite(snap.rsi)) {
        if (snap.rsi < 35)      { s.buy  += 25; reasons.push(`RSI ${snap.rsi.toFixed(1)} oversold → BUY +25`); }
        else if (snap.rsi > 65) { s.sell += 25; reasons.push(`RSI ${snap.rsi.toFixed(1)} overbought → SELL +25`); }
        else if (snap.rsi < 45) { s.buy  += 10; reasons.push(`RSI ${snap.rsi.toFixed(1)} slight oversold → BUY +10`); }
        else if (snap.rsi > 55) { s.sell += 10; reasons.push(`RSI ${snap.rsi.toFixed(1)} slight overbought → SELL +10`); }
    }

    // MACD — +30
    if (Number.isFinite(snap.macd.histogram)) {
        const h = snap.macd.histogram;
        if (h > 0)      { s.buy  += 30; reasons.push(`MACD hist +${h.toFixed(5)} → BUY +30`); }
        else if (h < 0) { s.sell += 30; reasons.push(`MACD hist ${h.toFixed(5)} → SELL +30`); }
    }

    // Volume — +30
    const trendDir: 'buy' | 'sell' = snap.ema_fast >= snap.ema_slow ? 'buy' : 'sell';
    if (vol.influxEvent) {
        s[trendDir] += 30;
        reasons.push(`Volume influx z=${vol.zscore.toFixed(2)} → ${trendDir.toUpperCase()} +30`);
    } else if (vol.regime === 'elevated') {
        s[trendDir] += 18;
        reasons.push(`Volume elevated → ${trendDir.toUpperCase()} +18`);
    } else if (vol.regime === 'normal') {
        s[trendDir] += 8;
        reasons.push(`Volume normal → ${trendDir.toUpperCase()} +8`);
    } else if (vol.regime === 'dry') {
        s.buy  *= 0.75;
        s.sell *= 0.75;
        reasons.push('Dry volume regime → score ×0.75');
    }

    // LightGBM — +55
    if (Number.isFinite(ml.probability)) {
        const distance = Math.abs(ml.probability - 0.5);
        const w = distance * 110;
        if (ml.probability >= 0.5) {
            s.buy  += w;
            reasons.push(`LightGBM p=${ml.probability.toFixed(2)} → BUY +${w.toFixed(1)}`);
        } else {
            s.sell += w;
            reasons.push(`LightGBM p=${ml.probability.toFixed(2)} → SELL +${w.toFixed(1)}`);
        }
    }

    let direction: FusionDirection =
        s.buy === 0 && s.sell === 0 ? 'NONE' :
        s.buy >= s.sell ? 'BUY' : 'SELL';
    const score = direction === 'BUY' ? s.buy : direction === 'SELL' ? s.sell : 0;

    let strength: FusionStrength = 'NONE';
    if (score >= 100)      strength = 'STRONG';
    else if (score >= 75)  strength = 'MEDIUM';
    else if (score >= 50)  strength = 'WEAK';
    if (strength === 'NONE') direction = 'NONE';

    const confidence = Math.max(0, Math.min(1, score / 150));

    return { direction, strength, score, rationale: reasons, confidence };
};

/**
 * Convenience: returns true if a signal is strong enough to even consider
 * for any execution mode (including virtual). Default 0.65 — the
 * Execution Engine has its own stricter thresholds for LIVE.
 */
export const passesEntryGate = (r: FusionResult, minConfidence = 0.65): boolean =>
    (r.strength === 'STRONG' || r.strength === 'MEDIUM' || r.strength === 'WEAK') &&
    r.direction !== 'NONE' &&
    r.confidence >= minConfidence;

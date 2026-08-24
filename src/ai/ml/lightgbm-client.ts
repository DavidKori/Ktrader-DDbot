/**
 * LightGBM Probability Client
 * ---------------------------
 * The SOLE AI layer of the system. Calls the FastAPI inference micro-service
 * in /server/ml_predict.py. Returns a neutral 0.5 on any network/parse error.
 *
 * No LLM, no chat, no API keys, no language model latency.
 * Pure tabular ML: numerical features in → probability out.
 */
import type { IndicatorSnapshot } from '../engine/indicator-engine';
import type { VolumeAnalysis }    from '../engine/adaptive-volume';

/**
 * ML endpoint resolution order:
 *   1. Vite build-time replacement of `import.meta.env.VITE_ML_ENDPOINT`
 *   2. Node-side `process.env.VITE_ML_ENDPOINT` (for SSR/server scripts)
 *   3. Browser-side `globalThis.VITE_ML_ENDPOINT` (manual override)
 *   4. Empty string -> the deterministic in-process fallback runs.
 *
 * IMPORTANT: There is no third-party default. Every deployment that wants
 * ML inference must either supply VITE_ML_ENDPOINT or run the FastAPI
 * service from `server/ml_predict.py`. Without it the engine returns a
 * neutral 0.5 probability, which is safe (no false-positive trades).
 */
const getViteEnv = (key: string): string | undefined => {
    try {
        if (typeof process !== 'undefined' && (process as any).env) {
            const v = (process as any).env[key];
            if (typeof v === 'string') return v;
        }
    } catch { /* fallthrough */ }
    return undefined;
};

const ML_URL =
    getViteEnv('VITE_ML_ENDPOINT') ||
    (typeof process !== 'undefined' && (process as any).env?.VITE_ML_ENDPOINT) ||
    (typeof globalThis !== 'undefined' && (globalThis as any).VITE_ML_ENDPOINT) ||
    '';

/**
 * Pure-numerical feature vector for the LightGBM booster.
 * NO language-AI inputs. All fields are derived from price/indicator data only.
 */
export interface MLFeatures {
    rsi: number;
    macd_hist: number;
    bollinger_bw: number;
    bollinger_pos: number;      // (price - lower) / (upper - lower) ∈ [0..1]
    atr: number;
    adx: number;
    ema_diff: number;           // ema_fast - ema_slow
    ema_diff_pct: number;       // ema_diff / lastClose
    vol_z: number;
    vol_regime_num: number;     // -1 dry, 0 normal, 1 elevated, 2 institutional
    momentum_5: number;         // (close - close[t-5]) / close[t-5]
    momentum_20: number;        // (close - close[t-20]) / close[t-20]
}

export interface MLPrediction {
    probability: number;        // 0..1 — probability the long-side signal succeeds
    confidence: 'low' | 'medium' | 'high';
    risk_score: number;         // 0..1 — higher = more dangerous
    direction_hint: 'BUY' | 'SELL' | 'NEUTRAL';   // derived from probability
}

const NEUTRAL: MLPrediction = {
    probability: 0.5, confidence: 'low', risk_score: 0.5, direction_hint: 'NEUTRAL',
};

const regimeNum = (r: VolumeAnalysis['regime']): number =>
    r === 'dry' ? -1 : r === 'normal' ? 0 : r === 'elevated' ? 1 : 2;

export const buildFeatures = (
    snap: IndicatorSnapshot,
    vol: VolumeAnalysis,
    recentCloses: number[],
): MLFeatures => {
    const last = snap.lastClose;
    const close5  = recentCloses[recentCloses.length - 6] ?? last;
    const close20 = recentCloses[recentCloses.length - 21] ?? last;

    const range = snap.bollinger.upper - snap.bollinger.lower;
    const bollinger_pos = range > 0 ? (last - snap.bollinger.lower) / range : 0.5;

    return {
        rsi:           Number.isFinite(snap.rsi) ? snap.rsi : 50,
        macd_hist:     Number.isFinite(snap.macd.histogram) ? snap.macd.histogram : 0,
        bollinger_bw:  Number.isFinite(snap.bollinger.bandwidth) ? snap.bollinger.bandwidth : 0,
        bollinger_pos,
        atr:           Number.isFinite(snap.atr) ? snap.atr : 0,
        adx:           Number.isFinite(snap.adx) ? snap.adx : 0,
        ema_diff:      Number.isFinite(snap.ema_fast - snap.ema_slow) ? snap.ema_fast - snap.ema_slow : 0,
        ema_diff_pct:  last > 0 && Number.isFinite(snap.ema_fast - snap.ema_slow)
                       ? (snap.ema_fast - snap.ema_slow) / last : 0,
        vol_z:         vol.zscore,
        vol_regime_num: regimeNum(vol.regime),
        momentum_5:    close5 > 0 ? (last - close5) / close5 : 0,
        momentum_20:   close20 > 0 ? (last - close20) / close20 : 0,
    };
};

export async function predictProbability(features: MLFeatures): Promise<MLPrediction> {
    // No endpoint configured -> deterministic neutral. This is the SAFE path:
    // VIRTUAL mode is the only thing that can fire on neutral probability.
    if (!ML_URL) return NEUTRAL;
    if (typeof fetch === 'undefined') return NEUTRAL;

    try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);

        const res = await fetch(ML_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(features),
            signal: ctl.signal,
        });
        clearTimeout(timer);

        if (!res.ok) return NEUTRAL;
        const data = await res.json();
        const probability = Math.max(0, Math.min(1, Number(data.probability) || 0.5));
        const confidence: MLPrediction['confidence'] =
            probability >= 0.80 ? 'high' : probability >= 0.65 ? 'medium' : 'low';
        const risk_score = Math.max(0, Math.min(1, Number(data.risk_score) || (1 - probability)));
        // Probability is for the "long-side success" head. >0.6 → BUY, <0.4 → SELL.
        const direction_hint: MLPrediction['direction_hint'] =
            probability >= 0.60 ? 'BUY' : probability <= 0.40 ? 'SELL' : 'NEUTRAL';
        return { probability, confidence, risk_score, direction_hint };
    } catch {
        return NEUTRAL;
    }
}

/**
 * Multi-Market Entry Scanner
 * --------------------------
 * Pure-function scanner. Given an array of "market snapshots" (one per
 * symbol, freshly built by the orchestrator from N recent ticks), it:
 *
 *   1. Computes indicators + adaptive volume per symbol.
 *   2. Builds digit distributions for synthetics.
 *   3. Calls LightGBM once per symbol to score direction probability.
 *   4. Detects the regime, picks the best strategy profile, finds the
 *      best entry digit (for digit-capable synthetics).
 *   5. Combines win-rate-of-last-N-virtual-trades + AI confidence +
 *      volume quality + trend strength into a 0..100 Quality Score.
 *   6. Ranks all markets and returns a sorted ScanResult[].
 *
 * Designed to run from the React UI ("Deep Scan for Best Market" button)
 * AND from the orchestrator as a continuous background surveillance loop.
 */
import { snapshot as indicatorSnapshot, Candle, IndicatorSnapshot } from '../engine/indicator-engine';
import { closedBarsOnly }                     from '../engine/no-repaint-guard';
import { analyzeVolume, VolumeAnalysis }     from '../engine/adaptive-volume';
import { buildDigitDistribution, bestMatchDigit, bestOverUnder } from '../engine/digit-stats';
import { buildFeatures, predictProbability, MLPrediction }       from '../ml/lightgbm-client';
import { detectRegime, MarketRegime, ContractType }              from '../regime/market-regime';
import { getSymbolMeta, getSymbolKind }      from '../../constants/all-symbols';

export interface ScanInputs {
    symbol: string;
    candles: Candle[];
    ticks: number[];                  // raw tick history (close prices)
    volumes: number[];                // synthetic-volume proxy
    /** Optional: recent virtual win rate for this symbol (0..1). */
    recentWinRate?: number;
    /**
     * v5.5.5 — injectable clock so replays/backtests are deterministic.
     * Defaults to `Date.now()`.
     */
    now?: number;
    /** Bar width in seconds. Inferred from the series when omitted. */
    timeframeSec?: number;
}

export interface ScanResult {
    symbol: string;
    displayName: string;
    qualityScore: number;             // 0..100
    rank: number;                     // 1 = best
    strategy: string;                  // human label
    contractType: ContractType | null;
    direction: 'UP' | 'DOWN' | 'NEUTRAL';
    entryDigit?: number;
    barrier?: number;
    winRate: number;                  // 0..1 — recent virtual / best-effort
    sampleSize: number;
    recentWinRate: number;
    confidence: number;               // 0..1 — fusion confidence
    regime: MarketRegime;
    snapshot: IndicatorSnapshot;
    volume: VolumeAnalysis;
    ml: MLPrediction;
    rationale: string[];
}

/**
 * Quality Score formula (institutional-grade weighting):
 *   confidence  × 40
 * + recentWR    × 30
 * + volumeQuality × 20
 * + trendStrength × 10
 *
 * Bounded 0..100.
 */
const computeQualityScore = (
    confidence: number,
    recentWinRate: number,
    vol: VolumeAnalysis,
    snap: IndicatorSnapshot,
): number => {
    const volumeQuality =
        vol.regime === 'institutional' ? 1 :
        vol.regime === 'elevated'      ? 0.75 :
        vol.regime === 'normal'        ? 0.5 :
                                          0.2;
    const trendStrength =
        Number.isFinite(snap.adx) ? Math.min(1, snap.adx / 40) : 0.3;
    const raw =
        confidence    * 40 +
        recentWinRate * 30 +
        volumeQuality * 20 +
        trendStrength * 10;
    return Math.max(0, Math.min(100, raw));
};

const pickStrategy = (
    regime: MarketRegime,
    digitPick: { kind: 'over' | 'under' | 'match' | null; barrier?: number; digit?: number } | null,
): { label: string; contractType: ContractType | null; direction: 'UP' | 'DOWN' | 'NEUTRAL';
     barrier?: number; entryDigit?: number } => {
    if (digitPick?.kind === 'over')   return { label: `Over ${digitPick.barrier}`,  contractType: 'DIGITOVER',  direction: 'NEUTRAL', barrier: digitPick.barrier };
    if (digitPick?.kind === 'under')  return { label: `Under ${digitPick.barrier}`, contractType: 'DIGITUNDER', direction: 'NEUTRAL', barrier: digitPick.barrier };
    if (digitPick?.kind === 'match')  return { label: `Match ${digitPick.digit}`,   contractType: 'DIGITMATCH', direction: 'NEUTRAL', entryDigit: digitPick.digit };

    switch (regime) {
        case 'trending_bull':     return { label: 'Trend-Following CALL', contractType: 'CALL', direction: 'UP'   };
        case 'trending_bear':     return { label: 'Trend-Following PUT',  contractType: 'PUT',  direction: 'DOWN' };
        case 'volatile_breakout': return { label: 'Breakout Momentum',    contractType: 'CALL', direction: 'UP'   };
        case 'mean_reverting':    return { label: 'Mean-Reversion',       contractType: 'CALL', direction: 'UP'   };
        case 'choppy_low_vol':    return { label: 'Skip — Chop',          contractType: null,   direction: 'NEUTRAL' };
        case 'unknown':           return { label: 'ML-Directional Wait',  contractType: null,   direction: 'NEUTRAL' };
    }
    return { label: '—', contractType: null, direction: 'NEUTRAL' };
};

export async function scanOne(input: ScanInputs): Promise<ScanResult | null> {
    // ── v5.5.5 NO-REPAINT (LAYER 3: module-local defence in depth) ──
    // The scanner is reachable from the orchestrator AND directly from the
    // Scanner UI, so it cannot rely on its caller having guarded. This pass is
    // idempotent: when the input is already closed-only it is a no-op.
    const candles = closedBarsOnly(input.candles, {
        now: input.now,
        timeframeSec: input.timeframeSec,
        label: input.symbol,
    });
    if (candles.length < 40 || input.ticks.length < 50) return null;

    const meta = getSymbolMeta(input.symbol);
    if (!meta) return null;
    const kind = getSymbolKind(input.symbol);

    // Keep the volume proxy the same length as the guarded series, otherwise
    // `analyzeVolume`'s rolling window would straddle a removed bar.
    const volumes = input.volumes.length === candles.length
        ? input.volumes
        : candles.map((_, i) => Math.abs(candles[i].close - (candles[i - 1]?.close ?? candles[i].close)));

    const snap = indicatorSnapshot(candles);
    const vol  = analyzeVolume(volumes);
    const features = buildFeatures(snap, vol, input.ticks);
    const ml = await predictProbability(features);
    const regimeRes = detectRegime(snap);

    // Digit analysis only for synthetics with digit support
    let digitPick: { kind: 'over' | 'under' | 'match' | null; barrier?: number; digit?: number } | null = null;
    if (kind === 'synthetic' && meta.kind === 'synthetic' && meta.supportsDigit) {
        const dist = buildDigitDistribution(input.ticks, 2, Math.min(input.ticks.length, 500));
        const ou = bestOverUnder(dist, 1.95);
        if (ou && ou.edge > 0.015) {
            digitPick = { kind: ou.side === 'OVER' ? 'over' : 'under', barrier: ou.barrier };
        } else {
            const m = bestMatchDigit(dist, 9.0, 0.015);
            if (m) digitPick = { kind: 'match', digit: m.digit };
        }
    }

    const strat = pickStrategy(regimeRes.regime, digitPick);

    // Confidence proxy from LightGBM + regime alignment
    const directionalAgreement =
        (strat.direction === 'UP'   && ml.direction_hint === 'BUY')  ||
        (strat.direction === 'DOWN' && ml.direction_hint === 'SELL') ||
        strat.direction === 'NEUTRAL';
    const baseConfidence = Math.abs(ml.probability - 0.5) * 2;     // 0..1
    const confidence = directionalAgreement ? baseConfidence : baseConfidence * 0.6;

    const recentWinRate = input.recentWinRate ?? 0.5;
    const qualityScore  = computeQualityScore(confidence, recentWinRate, vol, snap);

    const rationale = [
        `regime=${regimeRes.regime}`,
        `LightGBM p=${ml.probability.toFixed(2)} (${ml.direction_hint})`,
        `ADX=${snap.adx.toFixed(1)} BBbw=${snap.bollinger.bandwidth.toFixed(4)}`,
        `vol=${vol.regime} z=${vol.zscore.toFixed(2)}`,
        digitPick ? `digit-edge=${digitPick.kind}` : 'no-digit-edge',
        `qScore=${qualityScore.toFixed(2)}/100`,
    ];

    return {
        symbol: input.symbol,
        displayName: meta.display,
        qualityScore,
        rank: 0,
        strategy: strat.label,
        contractType: strat.contractType,
        direction: strat.direction,
        entryDigit: strat.entryDigit,
        barrier: strat.barrier,
        winRate: recentWinRate,
        sampleSize: Math.min(input.ticks.length, 500),
        recentWinRate,
        confidence,
        regime: regimeRes.regime,
        snapshot: snap, volume: vol, ml, rationale,
    };
}

/**
 * Scan all markets in parallel and return them ranked by qualityScore.
 */
export async function scanAll(inputs: ScanInputs[]): Promise<ScanResult[]> {
    const results = await Promise.all(inputs.map(i => scanOne(i).catch(() => null)));
    const valid = results.filter((r): r is ScanResult => r !== null);
    valid.sort((a, b) => b.qualityScore - a.qualityScore);
    valid.forEach((r, idx) => { r.rank = idx + 1; });
    return valid;
}

/**
 * Convenience: pick the single best market that has a tradeable contract.
 */
export const pickBestMarket = (results: ScanResult[]): ScanResult | null =>
    results.find(r => r.contractType !== null) ?? null;

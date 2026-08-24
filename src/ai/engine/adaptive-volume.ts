/**
 * Adaptive Volume Engine — z-score regime classification.
 * Works with synthetic tick velocity when real volume is unavailable.
 */
export type VolumeRegime = 'dry' | 'normal' | 'elevated' | 'institutional';

export interface VolumeAnalysis {
    zscore: number;
    rollingMean: number;
    rollingStd: number;
    regime: VolumeRegime;
    confidenceMultiplier: number;
    influxEvent: boolean;
}

export const analyzeVolume = (volumes: number[], window = 20): VolumeAnalysis => {
    if (volumes.length < window) {
        return { zscore: 0, rollingMean: 0, rollingStd: 0, regime: 'normal',
                 confidenceMultiplier: 1.0, influxEvent: false };
    }
    const slice = volumes.slice(-window);
    const mean = slice.reduce((a, b) => a + b, 0) / window;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / window;
    const std = Math.sqrt(variance);
    const current = volumes[volumes.length - 1];
    const z = std === 0 ? 0 : (current - mean) / std;

    let regime: VolumeRegime;
    if (z < -1.0)      regime = 'dry';
    else if (z < 1.0)  regime = 'normal';
    else if (z < 2.5)  regime = 'elevated';
    else               regime = 'institutional';

    const confidenceMultiplier =
        regime === 'dry' ? 0.5 :
        regime === 'institutional' ? 1.5 :
        regime === 'elevated' ? 1.25 : 1.0;

    return { zscore: z, rollingMean: mean, rollingStd: std,
             regime, confidenceMultiplier, influxEvent: z > 2.0 };
};

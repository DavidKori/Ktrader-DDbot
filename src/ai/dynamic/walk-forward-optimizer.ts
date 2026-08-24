/**
 * Walk-Forward Optimizer
 * ----------------------
 * Splits trade history into rolling train/test windows so we can detect
 * overfitting. A strategy is accepted only if out-of-sample expectancy
 * remains positive and stability ≥ minStability.
 *
 *   IS  = in-sample (train)
 *   OOS = out-of-sample (test, immediately after IS)
 *
 * Degradation = (IS_E - OOS_E) / max(|IS_E|, 1e-9)
 *   < 0.30 → robust
 *   ≥ 0.30 → likely overfit
 */

export interface Trade { pnl: number; ts: number; }

export interface WalkForwardResult {
  windows: number;
  isExpectancy: number;
  oosExpectancy: number;
  degradation: number;          // 0..1
  stability: number;            // 0..1 (1 - degradation, clamped)
  isOverfit: boolean;
  perWindow: Array<{ isE: number; oosE: number; }>;
}

export interface WalkForwardConfig {
  trainSize: number;     // # trades per train window
  testSize: number;      // # trades per test window
  step: number;          // step in trades (anchored or rolling)
  minStability: number;  // 0..1
}

export const DEFAULT_WF_CONFIG: WalkForwardConfig = {
  trainSize: 60,
  testSize: 30,
  step: 30,
  minStability: 0.65,
};

function expectancy(trades: Trade[]): number {
  if (!trades.length) return 0;
  return trades.reduce((s, t) => s + t.pnl, 0) / trades.length;
}

export class WalkForwardOptimizer {
  private cfg: WalkForwardConfig;
  constructor(cfg: Partial<WalkForwardConfig> = {}) {
    this.cfg = { ...DEFAULT_WF_CONFIG, ...cfg };
  }

  analyze(trades: Trade[]): WalkForwardResult {
    const { trainSize, testSize, step } = this.cfg;
    const need = trainSize + testSize;
    if (trades.length < need) {
      return {
        windows: 0, isExpectancy: 0, oosExpectancy: 0,
        degradation: 1, stability: 0, isOverfit: false, perWindow: [],
      };
    }
    const perWindow: Array<{ isE: number; oosE: number; }> = [];
    for (let start = 0; start + need <= trades.length; start += step) {
      const isSlice = trades.slice(start, start + trainSize);
      const oosSlice = trades.slice(start + trainSize, start + trainSize + testSize);
      perWindow.push({ isE: expectancy(isSlice), oosE: expectancy(oosSlice) });
    }
    const isExpectancy = perWindow.reduce((s, w) => s + w.isE, 0) / perWindow.length;
    const oosExpectancy = perWindow.reduce((s, w) => s + w.oosE, 0) / perWindow.length;
    const degradation = Math.max(0, (isExpectancy - oosExpectancy) / Math.max(Math.abs(isExpectancy), 1e-9));
    const stability = Math.max(0, Math.min(1, 1 - degradation));
    return {
      windows: perWindow.length,
      isExpectancy, oosExpectancy,
      degradation, stability,
      isOverfit: stability < this.cfg.minStability,
      perWindow,
    };
  }

  acceptable(trades: Trade[]): boolean {
    const r = this.analyze(trades);
    return r.windows > 0 && !r.isOverfit && r.oosExpectancy > 0;
  }
}

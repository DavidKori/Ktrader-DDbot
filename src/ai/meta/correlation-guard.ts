/**
 * Correlation Guard (Architecture #8)
 * ===================================
 * Prevents the meta-optimizer from concentrating exposure on correlated
 * pairs. Maintains a rolling Pearson correlation matrix of per-symbol
 * PnL and refuses to open a second position whose 30-trade correlation
 * with an already-open symbol exceeds a threshold.
 *
 * This is the missing piece in the original 5-module report: without it,
 * "Trade only the top 3 performers" can secretly mean "Trade three nearly
 * identical bets" (e.g. EURUSD + GBPUSD + AUDUSD all USD-direction).
 */

export interface CorrelationGuardConfig {
  windowSize: number;       // rolling trades used
  maxAllowed: number;       // |ρ| above which positions are blocked
  minSamples: number;       // below this, no guard (assume independent)
}

export const DEFAULT_CORR_CFG: CorrelationGuardConfig = {
  windowSize: 30,
  maxAllowed: 0.65,
  minSamples: 12,
};

export class CorrelationGuard {
  private history = new Map<string, number[]>();
  private readonly cfg: CorrelationGuardConfig;

  constructor(cfg: Partial<CorrelationGuardConfig> = {}) {
    this.cfg = { ...DEFAULT_CORR_CFG, ...cfg };
  }

  record(symbol: string, pnl: number): void {
    const arr = this.history.get(symbol) ?? [];
    arr.push(pnl);
    if (arr.length > this.cfg.windowSize) arr.shift();
    this.history.set(symbol, arr);
  }

  /** Pearson correlation of equal-length tails of the two series. */
  correlation(a: string, b: string): number {
    const xs = this.history.get(a) ?? [];
    const ys = this.history.get(b) ?? [];
    const n = Math.min(xs.length, ys.length);
    if (n < this.cfg.minSamples) return 0;
    const xt = xs.slice(-n);
    const yt = ys.slice(-n);
    const mx = xt.reduce((s, v) => s + v, 0) / n;
    const my = yt.reduce((s, v) => s + v, 0) / n;
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < n; i++) {
      const dx = xt[i] - mx, dy = yt[i] - my;
      cov += dx * dy; vx += dx * dx; vy += dy * dy;
    }
    const denom = Math.sqrt(vx * vy);
    return denom > 0 ? cov / denom : 0;
  }

  /** Returns true if opening `candidate` is safe given `openSymbols`. */
  allowOpen(candidate: string, openSymbols: string[]): { allow: boolean; reason: string; worstCorr: number } {
    let worst = 0; let worstSym = '';
    for (const s of openSymbols) {
      if (s === candidate) continue;
      const r = Math.abs(this.correlation(candidate, s));
      if (r > worst) { worst = r; worstSym = s; }
    }
    if (worst > this.cfg.maxAllowed) {
      return { allow: false, reason: `|ρ(${candidate},${worstSym})|=${worst.toFixed(2)} > ${this.cfg.maxAllowed}`, worstCorr: worst };
    }
    return { allow: true, reason: `max |ρ|=${worst.toFixed(2)} ≤ ${this.cfg.maxAllowed}`, worstCorr: worst };
  }
}

/**
 * Online Parameter Search (Architecture #7)
 * =========================================
 * Bayesian-style online optimizer for the TP/SL multiplier search space.
 * Maintains a Gaussian belief (mean μ, variance σ²) over expectancy for
 * each (tpMult, slMult) grid cell, updated via Welford's online algorithm.
 *
 * Thompson sampling: sample θ ~ N(μ, σ²) for each candidate, pick the
 * cell whose sample is highest. This naturally explores while exploiting.
 *
 * Used by MetaOptimizer to refine the bucket definitions themselves
 * (not just pick among presets) once a symbol has > 100 trades.
 */

export interface GridCell {
  tpMult: number;
  slMult: number;
  n: number;
  mean: number;
  m2: number;          // sum of squared deviations (Welford)
}

export interface ParamSearchConfig {
  tpRange: number[];   // candidate TP multipliers
  slRange: number[];   // candidate SL multipliers
  prior: { mean: number; samples: number };   // weakly-informative prior
}

export const DEFAULT_SEARCH_CFG: ParamSearchConfig = {
  tpRange: [1.8, 2.2, 2.5, 3.0, 3.5],
  slRange: [0.7, 0.9, 1.0, 1.2],
  prior: { mean: 0.0, samples: 1 },
};

export class ParameterSearch {
  private cells: GridCell[] = [];
  private readonly cfg: ParamSearchConfig;

  constructor(cfg: Partial<ParamSearchConfig> = {}) {
    this.cfg = { ...DEFAULT_SEARCH_CFG, ...cfg };
    for (const tp of this.cfg.tpRange) {
      for (const sl of this.cfg.slRange) {
        if (tp / sl < 1.5) continue;   // enforce R:R floor — but don't drop too much
        this.cells.push({ tpMult: tp, slMult: sl, n: this.cfg.prior.samples, mean: this.cfg.prior.mean, m2: 0 });
      }
    }
  }

  /** Welford incremental update. */
  record(tpMult: number, slMult: number, pnl: number): void {
    const cell = this.cellFor(tpMult, slMult);
    if (!cell) return;
    cell.n += 1;
    const delta = pnl - cell.mean;
    cell.mean += delta / cell.n;
    const delta2 = pnl - cell.mean;
    cell.m2 += delta * delta2;
  }

  private cellFor(tp: number, sl: number): GridCell | undefined {
    return this.cells.find(c => c.tpMult === tp && c.slMult === sl);
  }

  variance(c: GridCell): number {
    return c.n > 1 ? c.m2 / (c.n - 1) : 1.0;
  }

  /** Thompson sample → returns best (tp, sl). */
  sample(): { tpMult: number; slMult: number; expectedE: number } {
    let bestSample = -Infinity;
    let best = this.cells[0];
    for (const c of this.cells) {
      const sd = Math.sqrt(this.variance(c) / Math.max(1, c.n));
      const draw = c.mean + sd * gauss01();
      if (draw > bestSample) {
        bestSample = draw;
        best = c;
      }
    }
    return { tpMult: best.tpMult, slMult: best.slMult, expectedE: best.mean };
  }

  /** Greedy best (no sampling) — used when reporting current best. */
  best(): { tpMult: number; slMult: number; mean: number; n: number; sd: number } {
    let top = this.cells[0];
    for (const c of this.cells) if (c.mean > top.mean) top = c;
    return { tpMult: top.tpMult, slMult: top.slMult, mean: top.mean, n: top.n, sd: Math.sqrt(this.variance(top)) };
  }

  snapshot(): GridCell[] {
    return this.cells.map(c => ({ ...c }));
  }
}

function gauss01(): number {
  const u1 = Math.max(1e-9, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

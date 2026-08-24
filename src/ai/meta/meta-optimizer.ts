/**
 * Meta-Optimizer
 * ==============
 * Real-time selector for BOTH instrument AND parameter set, driven by
 * statistical edge decay. Sits on top of DynamicForexEngine and tells
 * the executor:
 *
 *   1. WHICH symbol(s) currently have a live, non-decayed edge
 *   2. WHICH parameter bucket (confidence floor, TP/SL multiplier,
 *      martingale on/off, stake fraction) to use for each symbol
 *   3. WHEN to refresh the parameter bucket (decay event)
 *
 * Design principles (from user constraints):
 *   - DO NOT over-filter: every symbol gets at least an exploration
 *     allocation as long as its edge isn't statistically dead.
 *   - Edge decay is measured by half-life Bayesian update on rolling
 *     expectancy with explicit confidence bands.
 *   - Parameter bucket selection uses Upper Confidence Bound (UCB1)
 *     to balance exploit (best known) vs explore (try alternatives).
 *
 * No LLM components. Pure statistics + LightGBM signal scores.
 */

export interface EdgeSample {
  symbol: string;
  bucket: string;       // parameter bucket id
  pnl: number;
  ts: number;
}

export interface ParamBucket {
  id: string;
  confidenceFloor: number;   // 0..1
  validationFloor: number;   // 0..100
  tpMultiplier: number;      // x ATR
  slMultiplier: number;      // x ATR
  stakeFraction: number;     // 0..1 of base
  martingaleEnabled: boolean;
}

/** Default search space — intentionally broad to AVOID over-filtering. */
export const DEFAULT_BUCKETS: ParamBucket[] = [
  // Wide nets — keep exploration alive
  { id: 'A-balanced',     confidenceFloor: 0.75, validationFloor: 70, tpMultiplier: 2.5, slMultiplier: 1.0, stakeFraction: 1.0, martingaleEnabled: true  },
  { id: 'B-tight',        confidenceFloor: 0.80, validationFloor: 72, tpMultiplier: 2.2, slMultiplier: 0.9, stakeFraction: 1.0, martingaleEnabled: true  },
  { id: 'C-wide-TP',      confidenceFloor: 0.75, validationFloor: 70, tpMultiplier: 3.0, slMultiplier: 1.1, stakeFraction: 1.0, martingaleEnabled: true  },
  { id: 'D-conservative', confidenceFloor: 0.82, validationFloor: 74, tpMultiplier: 2.0, slMultiplier: 0.8, stakeFraction: 0.6, martingaleEnabled: false },
  { id: 'E-explorer',     confidenceFloor: 0.72, validationFloor: 68, tpMultiplier: 2.5, slMultiplier: 1.0, stakeFraction: 0.4, martingaleEnabled: false },
];

export interface BucketStats {
  bucket: string;
  samples: number;
  mean: number;
  variance: number;
  ucb: number;          // upper confidence bound
  halfLifeEdge: number; // decay-weighted expectancy
  isDecayed: boolean;
}

export interface MetaDecision {
  symbol: string;
  recommendedBucket: ParamBucket;
  stats: BucketStats;
  exploreShare: number;   // 0..1 — how often to deviate for exploration
  rationale: string;
}

interface SymbolBook {
  samples: Map<string, EdgeSample[]>;       // bucket -> samples
  lastDecisionTs: number;
}

export interface MetaOptimizerConfig {
  buckets: ParamBucket[];
  halfLifeMs: number;              // decay half-life — 6h default
  minSamplesPerBucket: number;     // warmup floor; intentionally LOW (= 5) to avoid over-filtering
  explorationRate: number;         // baseline ε for ε-greedy
  decayDeadThreshold: number;      // expectancy floor below which a bucket is dead
  windowSize: number;              // max samples kept per bucket
  ucbConstant: number;             // c in UCB1: mean + c*sqrt(ln(n)/n_i)
}

export const DEFAULT_META_CFG: MetaOptimizerConfig = {
  buckets: DEFAULT_BUCKETS,
  halfLifeMs: 6 * 60 * 60 * 1000,
  minSamplesPerBucket: 5,
  explorationRate: 0.15,
  decayDeadThreshold: -0.10,
  windowSize: 200,
  ucbConstant: 1.4,
};

export class MetaOptimizer {
  private readonly cfg: MetaOptimizerConfig;
  private books = new Map<string, SymbolBook>();

  constructor(cfg: Partial<MetaOptimizerConfig> = {}) {
    this.cfg = { ...DEFAULT_META_CFG, ...cfg };
  }

  /** Record a closed trade result against the bucket it used. */
  record(s: EdgeSample): void {
    const book = this.bookFor(s.symbol);
    const arr = book.samples.get(s.bucket) ?? [];
    arr.push(s);
    if (arr.length > this.cfg.windowSize) arr.shift();
    book.samples.set(s.bucket, arr);
  }

  /** Per-bucket statistics with exponential decay weighting. */
  bucketStats(symbol: string, bucketId: string, now = Date.now()): BucketStats {
    const arr = this.books.get(symbol)?.samples.get(bucketId) ?? [];
    if (arr.length === 0) {
      return { bucket: bucketId, samples: 0, mean: 0, variance: 0, ucb: Infinity, halfLifeEdge: 0, isDecayed: false };
    }
    // Exponential decay: w_i = 0.5 ^ ((now - t_i) / halfLife)
    const lam = Math.LN2 / this.cfg.halfLifeMs;
    let wSum = 0, wMean = 0;
    for (const s of arr) {
      const age = Math.max(0, now - s.ts);
      const w = Math.exp(-lam * age);
      wSum += w;
      wMean += w * s.pnl;
    }
    const mean = wMean / Math.max(1e-9, wSum);
    let wVar = 0;
    for (const s of arr) {
      const w = Math.exp(-lam * Math.max(0, now - s.ts));
      wVar += w * (s.pnl - mean) ** 2;
    }
    const variance = wVar / Math.max(1e-9, wSum);
    const n = arr.length;
    // Total samples across all buckets of this symbol for UCB term
    const totalN = this.totalSamples(symbol);
    const ucb = mean + this.cfg.ucbConstant * Math.sqrt(Math.log(Math.max(1, totalN)) / Math.max(1, n));
    const halfLifeEdge = mean;
    const isDecayed = n >= this.cfg.minSamplesPerBucket && mean < this.cfg.decayDeadThreshold;
    return { bucket: bucketId, samples: n, mean, variance, ucb, halfLifeEdge, isDecayed };
  }

  /**
   * Select the best parameter bucket for a symbol RIGHT NOW.
   *
   * Algorithm:
   *   1. If any bucket has < minSamplesPerBucket samples → return it (forced exploration).
   *   2. Else pick argmax(UCB), unless all live buckets are decayed.
   *   3. With probability ε, deliberately pick a non-top bucket (exploration).
   *
   * This is "do not over-filter" by construction: every bucket gets warm-up
   * samples, and ε > 0 means even after warm-up some flow is sent to alternatives.
   */
  selectBucket(symbol: string, now = Date.now()): MetaDecision {
    const allStats = this.cfg.buckets.map(b => ({ b, s: this.bucketStats(symbol, b.id, now) }));

    // Phase 1: forced exploration during warm-up
    const underWarmed = allStats.filter(x => x.s.samples < this.cfg.minSamplesPerBucket);
    if (underWarmed.length > 0) {
      // Pick the one with the fewest samples
      underWarmed.sort((a, b) => a.s.samples - b.s.samples);
      const pick = underWarmed[0];
      return {
        symbol,
        recommendedBucket: pick.b,
        stats: pick.s,
        exploreShare: 1,
        rationale: `WARMUP bucket=${pick.b.id} (${pick.s.samples}/${this.cfg.minSamplesPerBucket})`,
      };
    }

    // Phase 2: filter out fully decayed buckets, but keep at least 2 alive
    let alive = allStats.filter(x => !x.s.isDecayed);
    if (alive.length < 2) {
      // Edge decay is widespread — keep top half by mean to stay anti-over-filter
      alive = allStats.slice().sort((a, b) => b.s.mean - a.s.mean).slice(0, Math.max(2, Math.ceil(allStats.length / 2)));
    }

    // ε-greedy exploration
    if (Math.random() < this.cfg.explorationRate) {
      const others = alive.filter(x => x.s.ucb !== Math.max(...alive.map(y => y.s.ucb)));
      const pick = (others.length ? others : alive)[Math.floor(Math.random() * (others.length || alive.length))];
      return {
        symbol,
        recommendedBucket: pick.b,
        stats: pick.s,
        exploreShare: this.cfg.explorationRate,
        rationale: `EXPLORE bucket=${pick.b.id} ε=${this.cfg.explorationRate}`,
      };
    }

    // Exploit best UCB
    alive.sort((a, b) => b.s.ucb - a.s.ucb);
    const pick = alive[0];
    return {
      symbol,
      recommendedBucket: pick.b,
      stats: pick.s,
      exploreShare: this.cfg.explorationRate,
      rationale: `EXPLOIT bucket=${pick.b.id} UCB=${pick.s.ucb.toFixed(3)} E=${pick.s.mean.toFixed(3)}`,
    };
  }

  /** Score a symbol overall — used by SymbolRanker to choose which symbols to trade. */
  symbolScore(symbol: string, now = Date.now()): number {
    const stats = this.cfg.buckets.map(b => this.bucketStats(symbol, b.id, now));
    const live = stats.filter(s => !s.isDecayed && s.samples > 0);
    if (live.length === 0) return 0;
    return Math.max(...live.map(s => s.mean));
  }

  totalSamples(symbol: string): number {
    const book = this.books.get(symbol);
    if (!book) return 0;
    let n = 0;
    for (const arr of book.samples.values()) n += arr.length;
    return n;
  }

  exportSnapshot(now = Date.now()): Record<string, BucketStats[]> {
    const out: Record<string, BucketStats[]> = {};
    for (const sym of this.books.keys()) {
      out[sym] = this.cfg.buckets.map(b => this.bucketStats(sym, b.id, now));
    }
    return out;
  }

  private bookFor(symbol: string): SymbolBook {
    let b = this.books.get(symbol);
    if (!b) {
      b = { samples: new Map(), lastDecisionTs: 0 };
      this.books.set(symbol, b);
    }
    return b;
  }
}

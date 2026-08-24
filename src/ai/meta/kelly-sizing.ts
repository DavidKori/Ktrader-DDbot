/**
 * Fractional Kelly Sizing (Architecture #10)
 * ==========================================
 * Computes a Kelly-fraction-bounded stake based on the *measured* edge
 * of the currently-selected (symbol, bucket) pair. We use FRACTIONAL
 * Kelly (default 0.25 Kelly) to dampen the variance penalty.
 *
 *   f* = (p*b - q) / b      where p = win rate, q = 1-p, b = avgWin/avgLoss
 *   stake = baseStake * clamp(kellyFraction * f*, 0, maxFraction)
 *
 * Crucially, when (p, b) are not yet statistically reliable (too few
 * samples), Kelly is FLOORED to baseStake * minFraction so the system
 * keeps generating data instead of refusing to trade.
 */

export interface KellyConfig {
  kellyFraction: number;   // 0..1, default 0.25
  minFraction: number;     // floor — keeps exploration alive
  maxFraction: number;     // hard ceiling (risk-of-ruin guard)
  minSamples: number;      // below this, use minFraction
}

export const DEFAULT_KELLY_CFG: KellyConfig = {
  kellyFraction: 0.25,
  minFraction: 0.5,
  maxFraction: 2.0,
  minSamples: 20,
};

export interface KellyInput {
  samples: number;
  winRate: number;        // 0..1
  avgWin: number;         // $
  avgLoss: number;        // $ (positive)
  baseStake: number;
}

export interface KellyOutput {
  stake: number;
  fStar: number;          // raw Kelly fraction
  applied: number;        // fractional Kelly used
  hasEdge: boolean;       // false = statistically-confirmed non-positive edge; caller MUST NOT trade live
  reason: string;
}

export function kellyStake(input: KellyInput, cfg: KellyConfig = DEFAULT_KELLY_CFG): KellyOutput {
  const { samples, winRate, avgWin, avgLoss, baseStake } = input;

  if (samples < cfg.minSamples || avgLoss <= 0) {
    // Not enough data to know whether there's an edge yet — this is a
    // WARM-UP floor, not a "no edge" verdict. Exploration continues, but
    // (see AutoTrader.decide) callers should still keep unproven symbols
    // in SHADOW mode until this warm-up period ends.
    return {
      stake: baseStake * cfg.minFraction,
      fStar: 0,
      applied: cfg.minFraction,
      hasEdge: true, // unproven, not disproven — warm-up still trades small by design
      reason: `floor (samples ${samples}/${cfg.minSamples})`,
    };
  }

  const b = avgWin / avgLoss;
  const p = winRate;
  const q = 1 - p;
  const fStar = (p * b - q) / Math.max(1e-9, b);

  if (fStar <= 0) {
    // We now HAVE enough samples, and they say the edge is zero or
    // negative. Kelly's own prescription for this case is "bet nothing" —
    // previously this fell through to the same minFraction floor as
    // warm-up, which meant the bot kept staking baseStake*0.5 on a
    // symbol/bucket it had just proven does not have positive expectancy.
    // Return stake 0 and hasEdge=false so callers stop trading it live.
    return {
      stake: 0,
      fStar,
      applied: 0,
      hasEdge: false,
      reason: `no edge (f*=${fStar.toFixed(3)}) — live trading blocked, shadow only`,
    };
  }

  let applied = cfg.kellyFraction * fStar;
  applied = Math.max(cfg.minFraction, Math.min(cfg.maxFraction, applied));

  return {
    stake: baseStake * applied,
    fStar,
    applied,
    hasEdge: true,
    reason: `f*=${fStar.toFixed(3)}, ${cfg.kellyFraction}x-Kelly → ${applied.toFixed(2)}× base`,
  };
}

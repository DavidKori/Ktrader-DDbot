/**
 * Expectancy Gate
 * ---------------
 * Computes per-symbol rolling expectancy and BLOCKS new entries when
 * expectancy is non-positive. This is the final risk-of-ruin filter
 * between signal generation and execution.
 *
 *   Expectancy E = (winRate * avgWin) - (lossRate * avgLoss)
 *
 * For forex multipliers we use realized PnL ($). For binary contracts
 * we use 0.95x payout (typical Deriv binary) vs full stake loss.
 *
 * Decision rules
 *   - Require >= MIN_SAMPLES trades before computing edge (warm-up).
 *   - During warm-up, allow ONLY virtual trades (shadow mode).
 *   - After warm-up, allow live entries only when E > MIN_EDGE (default $0.05/trade).
 *   - If win rate < 50% OR profit factor < 1.05, force shadow-only.
 */

export interface TradeResult {
  symbol: string;
  contractType: 'binary' | 'multiplier';
  stake: number;
  pnl: number;          // realised $ (positive = win)
  confidence: number;   // 0..1
  validation: number;   // 0..100
  ts: number;
}

export interface EdgeStats {
  samples: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;     // $ / trade
  profitFactor: number;
  sharpe: number;         // simple z = mean/std
  edgeOK: boolean;
  reason: string;
}

// v5.6.0 audited production gate. Forty closed trades is the minimum
// decision sample; PF 1.50 is required before live entries are allowed.
// A symbol can be positive by luck at n=20, so the old 20 / 1.05 gate was
// intentionally too permissive for automated trading.
const MIN_SAMPLES = 40;
const MIN_EDGE = 0.05;
const MIN_WIN_RATE = 0.55;
const MIN_PROFIT_FACTOR = 1.50;

export class ExpectancyGate {
  private history = new Map<string, TradeResult[]>();
  private maxWindow = 200;

  record(r: TradeResult): void {
    const arr = this.history.get(r.symbol) ?? [];
    arr.push(r);
    if (arr.length > this.maxWindow) arr.shift();
    this.history.set(r.symbol, arr);
  }

  stats(symbol: string): EdgeStats {
    const arr = this.history.get(symbol) ?? [];
    const samples = arr.length;
    const wins = arr.filter(t => t.pnl > 0);
    const losses = arr.filter(t => t.pnl <= 0);
    const winRate = samples ? wins.length / samples : 0;
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0);

    // Simple Sharpe
    let sharpe = 0;
    if (samples > 1) {
      const mean = arr.reduce((s, t) => s + t.pnl, 0) / samples;
      const variance = arr.reduce((s, t) => s + Math.pow(t.pnl - mean, 2), 0) / samples;
      const std = Math.sqrt(variance);
      sharpe = std > 0 ? mean / std : 0;
    }

    let edgeOK = false;
    let reason = '';
    if (samples < MIN_SAMPLES) {
      reason = `warmup (${samples}/${MIN_SAMPLES})`;
    } else if (winRate < MIN_WIN_RATE) {
      reason = `winRate ${(winRate * 100).toFixed(1)}% < ${MIN_WIN_RATE * 100}%`;
    } else if (profitFactor < MIN_PROFIT_FACTOR) {
      reason = `PF ${profitFactor.toFixed(2)} < ${MIN_PROFIT_FACTOR}`;
    } else if (expectancy < MIN_EDGE) {
      reason = `E $${expectancy.toFixed(3)} < $${MIN_EDGE}`;
    } else {
      edgeOK = true;
      reason = `E=$${expectancy.toFixed(3)}/trade, PF=${profitFactor.toFixed(2)}, WR=${(winRate * 100).toFixed(1)}%`;
    }

    return {
      samples, wins: wins.length, losses: losses.length,
      winRate, avgWin, avgLoss, expectancy, profitFactor, sharpe,
      edgeOK, reason,
    };
  }

  /** True only when the symbol qualifies for bulk concurrency. */
  allowBulk(symbol: string): { allow: boolean; reason: string; stats: EdgeStats } {
    const s = this.stats(symbol);
    const allow = s.samples >= MIN_SAMPLES && s.profitFactor >= MIN_PROFIT_FACTOR &&
      s.expectancy >= MIN_EDGE && s.winRate >= MIN_WIN_RATE;
    return { allow, reason: allow ? `bulk eligible: ${s.reason}` : `bulk blocked: ${s.reason}`, stats: s };
  }

  /** Should this symbol be allowed to take LIVE entries? */
  allowLive(symbol: string): { allow: boolean; reason: string; stats: EdgeStats } {
    const s = this.stats(symbol);
    return { allow: s.edgeOK, reason: s.reason, stats: s };
  }

  reset(symbol?: string): void {
    if (symbol) this.history.delete(symbol);
    else this.history.clear();
  }

  exportJSON(): Record<string, EdgeStats> {
    const out: Record<string, EdgeStats> = {};
    for (const sym of this.history.keys()) out[sym] = this.stats(sym);
    return out;
  }
}

export const MIN_EDGE_REQUIRED = MIN_EDGE;
export const MIN_SAMPLES_REQUIRED = MIN_SAMPLES;

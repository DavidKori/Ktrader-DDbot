/**
 * Asset Selector
 * --------------
 * Ranks forex pairs by a composite score that combines stability,
 * expectancy, Sharpe, and profit factor. The Orchestrator uses the
 * top-N symbols to focus capital on best performers.
 *
 * Composite Score (0..100):
 *   Stability    35% — penalises drawdown variance
 *   Expectancy   25% — $ per trade
 *   Sharpe       25% — risk-adjusted return
 *   ProfitFactor 15% — gross win / gross loss
 *
 * Rebalances on a rolling window so regime shifts get picked up.
 */

export interface SymbolPerformance {
  symbol: string;
  trades: number;
  wins: number;
  winRate: number;
  expectancy: number;
  profitFactor: number;
  sharpe: number;
  stability: number;       // 0..1 (1 = perfectly stable)
  drawdownVariance: number;
  recentTrend: 'up' | 'down' | 'stable';
  compositeScore: number;
}

export interface AssetSelectorConfig {
  symbols: string[];
  rollingWindow: number;      // trades to consider (default 100)
  topN: number;               // pairs to trade simultaneously (default 3)
  minTrades: number;          // warm-up before ranking (default 25)
  stabilityWeight: number;
  expectancyWeight: number;
  sharpeWeight: number;
  profitFactorWeight: number;
}

export const DEFAULT_SELECTOR_CFG: AssetSelectorConfig = {
  symbols: [
    'frxEURUSD',
    'frxGBPUSD',
    'frxUSDJPY',
    'frxAUDUSD',
    'frxNZDUSD',
    'frxUSDCHF',
    'frxEURGBP',
    'frxEURJPY',
    'frxGBPJPY',
    'frxAUDJPY',
    'frxEURAUD',
    'frxEURCAD',
    'frxGBPAUD',
    'frxUSDCAD',
    'frxXAUUSD',
    'frxXAGUSD',
    'R_10',
    'R_25',
    'R_50',
    'R_75',
    'R_100',
    '1HZ10V',
    '1HZ25V',
    '1HZ50V',
    '1HZ75V',
    '1HZ100V',
    '1HZ150V',
    '1HZ250V',
    '1HZ500V',
    '1HZ1000V',
    'BOOM300',
    'BOOM500',
    'BOOM1000',
    'CRASH300',
    'CRASH500',
    'CRASH1000',
    'stpRNG',
    'stpRNG2',
    'stpRNG3',
    'JD10',
    'JD25',
    'JD50',
    'JD75',
    'JD100',
    'RDBEAR',
    'RDBULL',
    'RDBRANGE100',
  ],
  rollingWindow: 100,
  topN: 3,
  minTrades: 25,
  stabilityWeight: 0.35,
  expectancyWeight: 0.25,
  sharpeWeight: 0.25,
  profitFactorWeight: 0.15,
};

interface TradePoint { pnl: number; ts: number; }

export class AssetSelector {
  private history = new Map<string, TradePoint[]>();
  private cfg: AssetSelectorConfig;

  constructor(cfg: Partial<AssetSelectorConfig> = {}) {
    this.cfg = { ...DEFAULT_SELECTOR_CFG, ...cfg };
    for (const s of this.cfg.symbols) this.history.set(s, []);
  }

  recordTrade(symbol: string, pnl: number, ts = Date.now()): void {
    const arr = this.history.get(symbol) ?? [];
    arr.push({ pnl, ts });
    if (arr.length > this.cfg.rollingWindow) arr.shift();
    this.history.set(symbol, arr);
  }

  private computePerformance(symbol: string): SymbolPerformance {
    const arr = this.history.get(symbol) ?? [];
    const trades = arr.length;
    if (trades < this.cfg.minTrades) {
      return {
        symbol, trades, wins: 0, winRate: 0, expectancy: 0,
        profitFactor: 0, sharpe: 0, stability: 0, drawdownVariance: 0,
        recentTrend: 'stable', compositeScore: 0,
      };
    }
    const pnls = arr.map(t => t.pnl);
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p <= 0);
    const winRate = wins.length / trades;
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const expectancy = (grossWin - grossLoss) / trades;
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0);
    const mean = expectancy;
    const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / trades;
    const std = Math.sqrt(variance);
    const sharpe = std > 0 ? mean / std : 0;

    // Drawdown variance over rolling equity curve
    let peak = 0, eq = 0;
    const drawdowns: number[] = [];
    for (const p of pnls) {
      eq += p;
      peak = Math.max(peak, eq);
      drawdowns.push(peak - eq);
    }
    const ddMean = drawdowns.reduce((a, b) => a + b, 0) / drawdowns.length;
    const ddVar = drawdowns.reduce((s, d) => s + (d - ddMean) ** 2, 0) / drawdowns.length;
    const stability = Math.max(0, Math.min(1, 1 - Math.sqrt(ddVar) / (Math.abs(mean) + 1)));

    // Trend over last 1/3 vs first 1/3
    const third = Math.floor(trades / 3);
    const recentSum = pnls.slice(-third).reduce((a, b) => a + b, 0);
    const oldSum = pnls.slice(0, third).reduce((a, b) => a + b, 0);
    const recentTrend: 'up' | 'down' | 'stable' =
      recentSum > oldSum * 1.1 ? 'up' :
      recentSum < oldSum * 0.9 ? 'down' : 'stable';

    // Normalised sub-scores
    const sStability = stability * 100;
    const sExp = Math.max(0, Math.min(100, expectancy * 100 + 50));
    const sSharpe = Math.max(0, Math.min(100, sharpe * 100 + 50));
    const sPF = Math.max(0, Math.min(100, profitFactor * 20));

    const c = this.cfg;
    const compositeScore =
      sStability * c.stabilityWeight +
      sExp * c.expectancyWeight +
      sSharpe * c.sharpeWeight +
      sPF * c.profitFactorWeight;

    return {
      symbol, trades, wins: wins.length, winRate, expectancy,
      profitFactor, sharpe, stability, drawdownVariance: ddVar,
      recentTrend, compositeScore,
    };
  }

  rankAll(): SymbolPerformance[] {
    return this.cfg.symbols
      .map(s => this.computePerformance(s))
      .sort((a, b) => b.compositeScore - a.compositeScore);
  }

  topSymbols(n = this.cfg.topN): string[] {
    return this.rankAll().slice(0, n).map(p => p.symbol);
  }

  shouldTrade(symbol: string): boolean {
    return this.topSymbols().includes(symbol);
  }

  reset(): void { this.history.clear(); }
}

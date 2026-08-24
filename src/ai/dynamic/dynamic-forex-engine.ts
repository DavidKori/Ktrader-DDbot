/**
 * Dynamic Forex Engine
 * --------------------
 * Top-level orchestrator that fuses:
 *   - AssetSelector       (which pairs)
 *   - RegimeDetector      (when)
 *   - AdaptiveRiskSizing  (how much / TP / SL)
 *   - WalkForwardOptimizer (overfit guard)
 *
 * Produces a TradeDecision for each candidate symbol that downstream
 * execution can act on.
 */

import {
  AssetSelector,
  AssetSelectorConfig,
  DEFAULT_SELECTOR_CFG,
  SymbolPerformance,
} from './asset-selector';
import {
  detectRegime,
  RegimeOutput,
  Candle,
} from './regime-detector';
import {
  computeAdaptiveRisk,
  RiskSizingOutput,
} from './adaptive-risk-sizing';
import {
  WalkForwardOptimizer,
  WalkForwardResult,
  Trade,
} from './walk-forward-optimizer';

export interface DynamicEngineConfig extends AssetSelectorConfig {
  minConfidence: number;
  accountBalance: number;
  multiplier: number;
  riskPerTrade: number;        // 0..1
  baseStake: number;
  rebalanceFrequency: number;  // # trades between asset rebalances
  aggressiveMode: boolean;     // allow ranging markets
}

export const DEFAULT_DYNAMIC_CFG: DynamicEngineConfig = {
  ...DEFAULT_SELECTOR_CFG,
  minConfidence: 0.75,
  accountBalance: 1000,
  multiplier: 100,
  riskPerTrade: 0.005,
  baseStake: 1,
  rebalanceFrequency: 100,
  aggressiveMode: false,
};

export interface TradeDecision {
  symbol: string;
  shouldTrade: boolean;
  reason: string;
  rank: number;
  regime: RegimeOutput;
  risk: RiskSizingOutput;
  perf: SymbolPerformance;
  walkForward: WalkForwardResult;
  tp: number; sl: number; trail: number;
  stake: number; riskReward: number;
  confidence: number;
}

export interface PortfolioMetrics {
  portfolioExpectancy: number;
  portfolioOOSExpectancy: number;
  portfolioStability: number;
  topSymbols: string[];
  isOverfitting: boolean;
  tradesRecorded: number;
}

export class DynamicForexEngine {
  cfg: DynamicEngineConfig;
  selector: AssetSelector;
  wfo: WalkForwardOptimizer;
  private history = new Map<string, Trade[]>();
  private totalTrades = 0;
  private tradesSinceRebalance = 0;
  private cachedTopSymbols: string[] = [];

  constructor(cfg: Partial<DynamicEngineConfig> = {}) {
    this.cfg = { ...DEFAULT_DYNAMIC_CFG, ...cfg };
    this.selector = new AssetSelector(this.cfg);
    this.wfo = new WalkForwardOptimizer();
    this.cachedTopSymbols = this.cfg.symbols.slice(0, this.cfg.topN);
  }

  recordTrade(symbol: string, win: boolean, pnl: number, drawdown = 0): void {
    this.totalTrades++;
    this.tradesSinceRebalance++;
    this.selector.recordTrade(symbol, pnl);
    const arr = this.history.get(symbol) ?? [];
    arr.push({ pnl, ts: Date.now() });
    if (arr.length > 500) arr.shift();
    this.history.set(symbol, arr);
    if (this.tradesSinceRebalance >= this.cfg.rebalanceFrequency) {
      this.cachedTopSymbols = this.selector.topSymbols(this.cfg.topN);
      this.tradesSinceRebalance = 0;
    }
  }

  getDecision(symbol: string, candles: Candle[], confidence: number, volHistory: number[] = []): TradeDecision {
    const rank = this.selector.rankAll();
    const perf = rank.find(r => r.symbol === symbol) ?? rank[0];
    const idx = rank.findIndex(r => r.symbol === symbol);
    const regime = detectRegime(candles, volHistory);
    const trades = this.history.get(symbol) ?? [];
    const wf = this.wfo.analyze(trades);

    const inTop = this.cachedTopSymbols.includes(symbol);
    const regimeOK = regime.shouldTrade || this.cfg.aggressiveMode;
    const confOK = confidence >= this.cfg.minConfidence;
    const wfOK = wf.windows === 0 || (!wf.isOverfit && wf.oosExpectancy >= 0);

    const risk = computeAdaptiveRisk({
      candles, price: candles[candles.length - 1]?.close ?? 0,
      accountBalance: this.cfg.accountBalance,
      multiplier: this.cfg.multiplier,
      riskPerTrade: this.cfg.riskPerTrade,
      baseStake: this.cfg.baseStake,
      confidence,
      tpMultiplier: regime.tpMultiplier,
      slMultiplier: regime.slMultiplier,
    });

    const shouldTrade = inTop && regimeOK && confOK && wfOK && risk.allowEntry;
    let reason = '';
    if (!inTop) reason = 'not in top-N';
    else if (!regimeOK) reason = `regime ${regime.regime} skipped`;
    else if (!confOK) reason = `confidence ${confidence.toFixed(3)} < ${this.cfg.minConfidence}`;
    else if (!wfOK) reason = `walk-forward fail (stability=${wf.stability.toFixed(2)})`;
    else if (!risk.allowEntry) reason = risk.reason;
    else reason = `OK: rank ${idx + 1}, ${regime.regime}, ${risk.reason}`;

    return {
      symbol, shouldTrade, reason,
      rank: idx + 1,
      regime, risk, perf, walkForward: wf,
      tp: risk.tpPips, sl: risk.slPips, trail: risk.trailingPips,
      stake: risk.stake, riskReward: risk.riskReward,
      confidence,
    };
  }

  getAllDecisions(
    symbolCandles: Record<string, Candle[]>,
    symbolConfidences: Record<string, number>,
    volHistoryBySymbol: Record<string, number[]> = {},
  ): TradeDecision[] {
    return this.cfg.symbols.map(s =>
      this.getDecision(s, symbolCandles[s] ?? [], symbolConfidences[s] ?? 0, volHistoryBySymbol[s] ?? [])
    ).sort((a, b) => (b.shouldTrade ? 1 : 0) - (a.shouldTrade ? 1 : 0) || a.rank - b.rank);
  }

  getMetrics(): PortfolioMetrics {
    let totalE = 0, totalOOS = 0, totalStab = 0, n = 0, overfit = false;
    for (const sym of this.cfg.symbols) {
      const wf = this.wfo.analyze(this.history.get(sym) ?? []);
      if (wf.windows > 0) {
        totalE += wf.isExpectancy;
        totalOOS += wf.oosExpectancy;
        totalStab += wf.stability;
        if (wf.isOverfit) overfit = true;
        n++;
      }
    }
    return {
      portfolioExpectancy: n ? totalE / n : 0,
      portfolioOOSExpectancy: n ? totalOOS / n : 0,
      portfolioStability: n ? totalStab / n : 0,
      topSymbols: this.cachedTopSymbols,
      isOverfitting: overfit,
      tradesRecorded: this.totalTrades,
    };
  }

  topSymbols(): string[] { return this.cachedTopSymbols; }
}

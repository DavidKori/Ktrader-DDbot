/**
 * Auto-Trader (Architecture #11) — top-level glue
 * ===============================================
 * Single entry point that the Orchestrator calls per tick. It composes:
 *   - MetaOptimizer       (instrument + bucket via UCB / ε-greedy)
 *   - EdgeDecayMonitor    (refuse decayed symbols)
 *   - ParameterSearch     (Thompson-sampled TP/SL grid)
 *   - CorrelationGuard    (avoid concentrated exposure)
 *   - RegimeMemory        (warm-start by regime)
 *   - KellyStake          (size by measured edge)
 *
 * Output: AutoTradeDecision — what to do for each candidate symbol RIGHT NOW.
 *
 * "Auto trade what is profitable" — the AutoTrader only returns shouldTrade=true
 * for symbols whose live edge is positive AND not decayed AND not over-correlated
 * with currently-open positions. Everything else is held in SHADOW mode so
 * learning continues without risking capital.
 */

import { MetaOptimizer, ParamBucket, MetaDecision, DEFAULT_META_CFG, MetaOptimizerConfig } from './meta-optimizer';
import { detectDecay, DecaySignal } from './edge-decay-monitor';
import { ParameterSearch } from './parameter-search';
import { CorrelationGuard } from './correlation-guard';
import { RegimeMemory, RegimeId } from './regime-memory';
import { kellyStake, KellyConfig, DEFAULT_KELLY_CFG } from './kelly-sizing';

export interface AutoTradeInput {
  symbol: string;
  regime: RegimeId;
  recentPnL: number[];       // last N closed-trade PnLs for this symbol
  winRate: number;
  avgWin: number;
  avgLoss: number;
  openSymbols: string[];     // symbols currently in open positions
  baseStake: number;
}

export interface AutoTradeDecision {
  symbol: string;
  shouldTrade: boolean;
  mode: 'LIVE' | 'SHADOW' | 'REDUCED' | 'BLOCKED';
  bucket: ParamBucket;
  stake: number;
  decay: DecaySignal;
  meta: MetaDecision;
  reason: string;
}

export interface AutoTraderConfig {
  meta: Partial<MetaOptimizerConfig>;
  kelly: KellyConfig;
  decayMinSamples: number;
}

export class AutoTrader {
  readonly meta: MetaOptimizer;
  readonly search = new ParameterSearch();
  readonly corr = new CorrelationGuard();
  readonly mem = new RegimeMemory();
  private readonly cfg: AutoTraderConfig;

  constructor(cfg: Partial<AutoTraderConfig> = {}) {
    this.cfg = {
      meta: cfg.meta ?? DEFAULT_META_CFG,
      kelly: cfg.kelly ?? DEFAULT_KELLY_CFG,
      decayMinSamples: cfg.decayMinSamples ?? 24,
    };
    this.meta = new MetaOptimizer(this.cfg.meta);
  }

  /** Called after every closed trade. */
  recordResult(opts: {
    symbol: string;
    regime: RegimeId;
    bucketId: string;
    tpMult: number;
    slMult: number;
    pnl: number;
  }): void {
    this.meta.record({ symbol: opts.symbol, bucket: opts.bucketId, pnl: opts.pnl, ts: Date.now() });
    this.search.record(opts.tpMult, opts.slMult, opts.pnl);
    this.corr.record(opts.symbol, opts.pnl);
    this.mem.update(opts.symbol, opts.regime, opts.bucketId, opts.pnl);
  }

  /** Called per tick when a fresh LightGBM signal exists. */
  decide(input: AutoTradeInput): AutoTradeDecision {
    // 1. Regime memory warm-start: prefer a known-good bucket if we have one
    const recall = this.mem.recall(input.symbol, input.regime);

    // 2. Meta-optimizer picks bucket (UCB/ε-greedy across param buckets)
    const metaDec = this.meta.selectBucket(input.symbol);
    let bucket = metaDec.recommendedBucket;
    if (recall && recall.samples >= 10 && recall.expectancy > 0) {
      const recalled = this.meta['cfg'].buckets.find(b => b.id === recall.bestBucket);
      if (recalled && metaDec.stats.samples < 10) bucket = recalled;
    }

    // 3. Edge-decay check
    const decay = detectDecay({ symbol: input.symbol, pnlSeries: input.recentPnL }, this.cfg.decayMinSamples);

    // 4. Correlation guard
    const corrCheck = this.corr.allowOpen(input.symbol, input.openSymbols);

    // 5. Kelly stake (measured edge)
    const kelly = kellyStake({
      samples: input.recentPnL.length,
      winRate: input.winRate,
      avgWin: input.avgWin,
      avgLoss: input.avgLoss,
      baseStake: input.baseStake * bucket.stakeFraction,
    }, this.cfg.kelly);

    // 6. Compose final decision
    let mode: AutoTradeDecision['mode'] = 'LIVE';
    let shouldTrade = true;
    const reasons: string[] = [metaDec.rationale, decay.reason];

    if (decay.action === 'STOP') {
      mode = 'BLOCKED'; shouldTrade = false; reasons.push('decay STOP');
    } else if (decay.action === 'SHADOW') {
      mode = 'SHADOW'; shouldTrade = false; reasons.push('decay SHADOW');
    } else if (decay.action === 'REDUCE') {
      mode = 'REDUCED'; reasons.push('decay REDUCE → stake/2');
    }
    if (!corrCheck.allow) {
      mode = 'BLOCKED'; shouldTrade = false; reasons.push(corrCheck.reason);
    }
    // Measured-edge gate — Kelly says this symbol/bucket has proven
    // non-positive expectancy (enough samples exist to know, not just
    // warm-up). Previously `kelly.hasEdge` was computed but never checked
    // here, so the bot kept trading LIVE at a floored stake even when its
    // own edge measurement said not to. Docstring above promises
    // shouldTrade=true only "for symbols whose live edge is positive" —
    // this makes that actually true.
    if (!kelly.hasEdge && mode !== 'BLOCKED') {
      mode = 'SHADOW'; shouldTrade = false; reasons.push(kelly.reason);
    }
    const finalStake = (mode === 'REDUCED') ? kelly.stake * 0.5 : kelly.stake;

    return {
      symbol: input.symbol,
      shouldTrade,
      mode,
      bucket,
      stake: finalStake,
      decay,
      meta: metaDec,
      reason: reasons.join(' | '),
    };
  }
}

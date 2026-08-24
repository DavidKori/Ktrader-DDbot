/**
 * Risk Engine — survival layer with cooldown.
 * -------------------------------------------
 * Final go/no-go check after the ExecutionEngine has chosen mode + stake.
 *
 * Enforces:
 *  • Daily Loss Limit
 *  • Max Drawdown
 *  • Exposure Limit
 *  • Max Consecutive Losses
 *  • Cooldown timer between trades on the same symbol
 *  • ATR-sized SL/TP fallback (orchestrator usually overrides with the
 *    DurationPlan)
 *
 * VIRTUAL mode bypasses every gate — no real exposure.
 */
export interface RiskInputs {
    mode: 'VIRTUAL' | 'LIVE' | 'LIVE_MARTINGALE';
    stake: number;
    accountBalance: number;
    dailyPnL: number;
    openExposureUSD: number;
    consecutiveLosses: number;
    atr: number;
    pip: number;
    /** Last trade timestamp on THIS symbol — for cooldown gating. */
    lastTradeAt?: number;
    symbol: string;
}

export interface RiskOutput {
    allowed: boolean;
    reason?: string;
    stake: number;
    multiplier?: number;
    stopLossPips: number;
    takeProfitPips: number;
}

export interface RiskConfig {
    maxDailyDrawdownPct: number;
    maxConsecutiveLosses: number;
    maxExposurePct: number;
    maxStake: number;
    multiplierForex: number;
    cooldownBetweenTradesMs: number;
}

export const DEFAULT_RISK: RiskConfig = {
    maxDailyDrawdownPct: 0.05,
    maxConsecutiveLosses: 3,
    maxExposurePct: 0.20,         // share of balance; measured in STAKE units (max loss)
    maxStake: 50,
    multiplierForex: 100,
    cooldownBetweenTradesMs: 8_000,    // 8 s gap on the same symbol
};

const baseFail = (reason: string): RiskOutput =>
    ({ allowed: false, reason, stake: 0, stopLossPips: 0, takeProfitPips: 0 });

export const evaluateRisk = (i: RiskInputs, cfg: RiskConfig = DEFAULT_RISK): RiskOutput => {
    if (i.mode === 'VIRTUAL') {
        return { allowed: true, stake: 0, stopLossPips: 0, takeProfitPips: 0 };
    }
    if (i.accountBalance <= 0) return baseFail('Zero balance');
    if (i.dailyPnL <= -cfg.maxDailyDrawdownPct * i.accountBalance) {
        return baseFail(`Daily DD ${(cfg.maxDailyDrawdownPct * 100).toFixed(0)}% breached`);
    }
    if (i.consecutiveLosses >= cfg.maxConsecutiveLosses) {
        return baseFail(`Circuit breaker — ${i.consecutiveLosses} consecutive losses`);
    }
    if (i.lastTradeAt && Date.now() - i.lastTradeAt < cfg.cooldownBetweenTradesMs) {
        const wait = ((cfg.cooldownBetweenTradesMs - (Date.now() - i.lastTradeAt)) / 1000).toFixed(0);
        return baseFail(`Cooldown — wait ${wait}s on ${i.symbol}`);
    }
    const stake = Math.min(i.stake, cfg.maxStake);
    if (!Number.isFinite(stake) || stake <= 0) {
        return baseFail('Invalid stake');
    }

    const safePip = Number.isFinite(i.pip) && i.pip > 0 ? i.pip : 0;
    const safeAtr = Number.isFinite(i.atr) && i.atr > 0 ? i.atr : 0;
    const atrInPips = safePip > 0 && safeAtr > 0 ? safeAtr / safePip : 0;
    const sl = Math.max(5,  Math.round((atrInPips || 5) * 1.0));
    const tp = Math.max(10, Math.round((atrInPips || 5) * 2.0));

    const multiplier = cfg.multiplierForex;
    // Deriv Multiplier contracts auto stop-out at 100% of stake — the max real
    // loss is the stake itself, NOT stake × multiplier (notional is buying power).
    const exposureAfter = i.openExposureUSD + stake;
    if (exposureAfter > i.accountBalance * cfg.maxExposurePct) {
        return baseFail('Aggregate exposure cap exceeded');
    }
    return { allowed: true, stake, multiplier, stopLossPips: sl, takeProfitPips: tp };
};

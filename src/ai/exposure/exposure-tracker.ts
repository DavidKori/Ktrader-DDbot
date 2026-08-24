/**
 * ExposureTracker — v5.2 (Priority 2)
 * -----------------------------------
 * Rolling counters for trades-per-hour and trades-per-day, plus per-symbol and
 * total notional exposure. Returns a veto reason when a limit is breached.
 */
import { ExposureLimits, DEFAULT_EXPOSURE_LIMITS } from '../config/exposure-controls';

// Re-export so consumers can `import { DEFAULT_EXPOSURE_LIMITS } from '.../exposure-tracker'`.
export { DEFAULT_EXPOSURE_LIMITS };
export type { ExposureLimits };

interface TradeStamp { ts: number; symbol: string; notional: number; }

export interface ExposureSnapshot {
    tradesLastHour:  number;
    tradesToday:     number;
    notionalBySymbol: Record<string, number>;
    notionalTotal:   number;
    healthy:         boolean;
    reason?:         string;
}

export class ExposureTracker {
    private trades: TradeStamp[] = [];
    private openNotional = new Map<string, number>();
    constructor(public cfg: ExposureLimits = DEFAULT_EXPOSURE_LIMITS) {}

    /** Record a trade open. notional = stake × multiplier. */
    recordOpen(symbol: string, notional: number) {
        const ts = Date.now();
        this.trades.push({ ts, symbol, notional });
        this.prune();
        this.openNotional.set(symbol, (this.openNotional.get(symbol) ?? 0) + notional);
    }

    /** Record a trade close (frees the notional). */
    recordClose(symbol: string, notional: number) {
        const cur = this.openNotional.get(symbol) ?? 0;
        const next = Math.max(0, cur - notional);
        if (next === 0) this.openNotional.delete(symbol);
        else this.openNotional.set(symbol, next);
    }

    /** Returns rejection reason if a new trade would breach any limit. */
    canOpen(symbol: string, notional: number, accountBalance: number): { allowed: boolean; reason?: string } {
        this.prune();
        const now = Date.now();
        const hourAgo = now - 3_600_000;
        const tradesLastHour = this.trades.filter(t => t.ts >= hourAgo).length;
        const tradesToday    = this.trades.length;

        if (tradesToday >= this.cfg.maxTradesPerDay) {
            return { allowed: false, reason: `daily trade cap reached (${tradesToday}/${this.cfg.maxTradesPerDay})` };
        }
        if (tradesLastHour >= this.cfg.maxTradesPerHour) {
            return { allowed: false, reason: `hourly trade cap reached (${tradesLastHour}/${this.cfg.maxTradesPerHour})` };
        }
        const symCur = this.openNotional.get(symbol) ?? 0;
        if (accountBalance > 0 && (symCur + notional) / accountBalance > this.cfg.maxExposurePerSymbol) {
            return { allowed: false, reason: `per-symbol exposure ${(this.cfg.maxExposurePerSymbol*100).toFixed(0)}% would be breached on ${symbol}` };
        }
        const totalCur = Array.from(this.openNotional.values()).reduce((a, b) => a + b, 0);
        if (accountBalance > 0 && (totalCur + notional) / accountBalance > this.cfg.maxExposureTotal) {
            return { allowed: false, reason: `total exposure cap ${(this.cfg.maxExposureTotal*100).toFixed(0)}% would be breached` };
        }
        return { allowed: true };
    }

    snapshot(): ExposureSnapshot {
        this.prune();
        const now = Date.now();
        const hourAgo = now - 3_600_000;
        const tradesLastHour = this.trades.filter(t => t.ts >= hourAgo).length;
        const tradesToday    = this.trades.length;
        const obj: Record<string, number> = {};
        this.openNotional.forEach((v, k) => { obj[k] = v; });
        const notionalTotal = Array.from(this.openNotional.values()).reduce((a, b) => a + b, 0);
        return {
            tradesLastHour, tradesToday,
            notionalBySymbol: obj, notionalTotal,
            healthy: tradesToday < this.cfg.maxTradesPerDay &&
                     tradesLastHour < this.cfg.maxTradesPerHour,
        };
    }

    /** Drop trade stamps older than 24 h. */
    private prune() {
        const dayAgo = Date.now() - 86_400_000;
        if (this.trades.length && this.trades[0].ts < dayAgo) {
            this.trades = this.trades.filter(t => t.ts >= dayAgo);
        }
    }

    reset() {
        this.trades = [];
        this.openNotional.clear();
    }
}

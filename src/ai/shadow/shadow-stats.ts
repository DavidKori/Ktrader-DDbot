/**
 * Shadow-Mode Analytics — v5.2 (Priority 5)
 * ------------------------------------------
 * Records every virtual signal + its eventual outcome, then computes the
 * standard institutional metrics so the user can verify the engine has actual
 * edge BEFORE risking real money.
 *
 * Computed metrics:
 *   • win rate
 *   • profit factor
 *   • expectancy per trade
 *   • Sharpe ratio (per-trade returns; annualized factor omitted)
 *   • max drawdown over the virtual equity curve
 *
 * Persisted to localStorage when available; in-memory otherwise.
 */
export interface ShadowSignal {
    id:           string;
    ts:           number;          // unix ms
    symbol:       string;
    direction:    'BUY' | 'SELL' | 'NONE';
    confidence:   number;          // 0..1
    validation:   number;          // 0..100
    contractType?: string;
    /** Computed at resolution time. */
    won?:         boolean;
    pnl?:         number;
    resolvedAt?:  number;
    reason?:      string;          // exit reason or 'TIMEOUT'
}

export interface ShadowStats {
    samples:        number;
    closed:         number;
    wins:           number;
    losses:         number;
    winRate:        number;        // 0..1
    grossWin:       number;
    grossLoss:      number;        // negative
    netPnL:         number;
    profitFactor:   number;        // grossWin / |grossLoss|
    expectancy:     number;        // netPnL / closed
    sharpe:         number;        // mean / std (per-trade, non-annualized)
    maxDrawdown:    number;        // worst peak-to-trough of equity curve
    avgConfidence:  number;
    avgValidation:  number;
}

const STORAGE_KEY = 'twk_shadow_v1';
const isBrowser = (): boolean =>
    typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const safeLoad = (): ShadowSignal[] => {
    if (!isBrowser()) return [];
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
};

const safeSave = (entries: ShadowSignal[]) => {
    if (!isBrowser()) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-2000))); }
    catch {}
};

export class ShadowStatsEngine {
    private signals: ShadowSignal[];
    public listeners = new Set<(s: ShadowSignal[]) => void>();

    constructor() { this.signals = safeLoad(); }

    record(s: Omit<ShadowSignal, 'id' | 'ts'> & { id?: string }): string {
        const id = s.id ?? `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.signals.push({ ...s, id, ts: Date.now() });
        this.flush();
        return id;
    }

    resolve(id: string, patch: { won: boolean; pnl: number; reason?: string }) {
        const idx = this.signals.findIndex(x => x.id === id);
        if (idx === -1) return;
        this.signals[idx] = { ...this.signals[idx], ...patch, resolvedAt: Date.now() };
        this.flush();
    }

    all(): ShadowSignal[] { return this.signals.slice(); }
    clear() { this.signals = []; this.flush(); }

    /** Compute the institutional metrics over the closed virtual trades. */
    stats(window?: number): ShadowStats {
        const closed = (window
            ? this.signals.slice(-window)
            : this.signals).filter(s => typeof s.pnl === 'number');

        const wins   = closed.filter(s => (s.pnl ?? 0) > 0);
        const losses = closed.filter(s => (s.pnl ?? 0) < 0);
        const grossWin  = wins.reduce((a, s) => a + (s.pnl ?? 0), 0);
        const grossLoss = losses.reduce((a, s) => a + (s.pnl ?? 0), 0);
        const netPnL = grossWin + grossLoss;

        // Sharpe (per-trade): mean / std
        const returns = closed.map(s => s.pnl ?? 0);
        const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
        const variance = returns.length
            ? returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length : 0;
        const std = Math.sqrt(variance);
        const sharpe = std > 0 ? mean / std : 0;

        // Max drawdown over equity curve
        let peak = 0, equity = 0, maxDD = 0;
        for (const r of returns) {
            equity += r;
            if (equity > peak) peak = equity;
            const dd = peak - equity;
            if (dd > maxDD) maxDD = dd;
        }

        const avgConfidence = closed.length
            ? closed.reduce((a, s) => a + s.confidence, 0) / closed.length : 0;
        const avgValidation = closed.length
            ? closed.reduce((a, s) => a + s.validation, 0) / closed.length : 0;

        return {
            samples:       this.signals.length,
            closed:        closed.length,
            wins:          wins.length,
            losses:        losses.length,
            winRate:       closed.length ? wins.length / closed.length : 0,
            grossWin, grossLoss, netPnL,
            profitFactor:  grossLoss === 0 ? (grossWin > 0 ? Infinity : 0)
                                            : grossWin / Math.abs(grossLoss),
            expectancy:    closed.length ? netPnL / closed.length : 0,
            sharpe,
            maxDrawdown:   maxDD,
            avgConfidence, avgValidation,
        };
    }

    /** Does the engine show statistical edge? Conservative thresholds. */
    hasEdge(opts: { minSamples?: number; minWinRate?: number; minProfitFactor?: number } = {}): boolean {
        const minN  = opts.minSamples ?? 50;
        const minWR = opts.minWinRate ?? 0.55;
        const minPF = opts.minProfitFactor ?? 1.20;
        const s = this.stats();
        return s.closed >= minN && s.winRate >= minWR && s.profitFactor >= minPF;
    }

    /** CSV export for offline analysis. */
    toCSV(): string {
        const header = 'id,ts,resolved_ts,symbol,direction,contract,confidence,validation,won,pnl,reason';
        const rows = this.signals.map(s => [
            s.id, s.ts, s.resolvedAt ?? '',
            s.symbol, s.direction, s.contractType ?? '',
            s.confidence.toFixed(3), s.validation.toFixed(1),
            s.won === undefined ? '' : (s.won ? 1 : 0),
            s.pnl ?? '',
            s.reason ?? '',
        ].join(','));
        return [header, ...rows].join('\n');
    }

    private flush() {
        safeSave(this.signals);
        const snap = this.signals.slice();
        this.listeners.forEach(l => { try { l(snap); } catch {} });
    }
}

/**
 * Deriv WebSocket wrapper — v5.2 resilient edition.
 *
 *   • Heartbeat ping every 15 s
 *   • Auto-reconnect with exponential backoff (1s → 30s, unlimited attempts)
 *   • onClose / onError handlers wired into orchestrator callbacks
 *   • lastTickTimestamp tracking → DEGRADED status if stale > 30 s
 *   • Re-subscribes all symbol tick streams after reconnect
 *
 * v5.6.0 — all browser sessions connect directly to Deriv WebSocket.
 * Vercel serverless does not support the old raw upgrade proxy architecture.
 *
 * v5.5.5 — NO-REPAINT: `getCandles()` now sanitises the raw feed at the source.
 * Deriv's `ticks_history({ end: 'latest', style: 'candles' })` returns the
 * currently-forming bar as the last element; see `getCandles` for details.
 */
import { guardCandles } from '../engine/no-repaint-guard';

type Callback<T> = (data: T) => void;

export const DERIV_DEFAULT_APP_ID = String((typeof process !== 'undefined' && (process as any).env?.DERIV_APP_ID) || '');

export interface DerivTick { epoch: number; quote: number; symbol: string; }

export interface DerivBuyMultiplier {
    symbol: string;
    direction: 'UP' | 'DOWN';
    stake: number;
    multiplier: number;
    stopLossPips?: number;
    takeProfitPips?: number;
}

export interface DerivBuyBinary {
    symbol: string;
    contractType: 'CALL' | 'PUT' | 'DIGITMATCH' | 'DIGITDIFF' | 'DIGITOVER' | 'DIGITUNDER';
    stake: number;
    durationTicks?: number;
    barrier?: number;
    targetDigit?: number;
}

export interface DerivBuyResult { contractId: string; buyPrice: number; payout: number; }

export type ConnectionStatus = 'CONNECTING' | 'CONNECTED' | 'DEGRADED' | 'RECONNECTING' | 'DISCONNECTED';

export interface DerivClientEvents {
    onStatusChange?: (status: ConnectionStatus, info?: string) => void;
    onDisconnect?:   (reason: string) => void;
    onReconnect?:    (attempt: number) => void;
    onTickStaleness?: (ageSec: number) => void;
}

interface SubInfo {
    symbol: string;
    cb: Callback<DerivTick>;
    sub: any;
}

const STALE_TICK_THRESHOLD_MS = 30_000;   // 30 s of silence -> DEGRADED
const HEARTBEAT_INTERVAL_MS   = 15_000;
const MAX_RECONNECT_ATTEMPTS  = 0; // 0 = unlimited; required for long-lived Vercel WebSocket rotation

export class DerivClient {
    private api: any = null;
    private subs = new Map<string, SubInfo>();
    private status: ConnectionStatus = 'DISCONNECTED';
    private events: DerivClientEvents = {};

    private heartbeatTimer: any = null;
    private stalenessTimer: any = null;
    private reconnectTimer: any = null;
    private reconnectAttempt = 0;
    private intentionalDisconnect = false;

    /** Most recent tick timestamp across ALL subscribed symbols (ms). */
    public lastTickTimestamp = 0;
    /** Total reconnect attempts since instantiation (read by kill switch). */
    public reconnectCount = 0;

    constructor(private token: string, _appId: string = DERIV_DEFAULT_APP_ID) {}

    /** Wire listeners BEFORE calling connect(). */
    setEvents(events: DerivClientEvents) {
        this.events = events;
    }

    getStatus(): ConnectionStatus { return this.status; }

    private setStatus(s: ConnectionStatus, info?: string) {
        if (this.status === s) return;
        this.status = s;
        try { this.events.onStatusChange?.(s, info); } catch {}
    }

    /** Seconds since the most recent tick across all subscriptions. */
    tickAgeSec(): number {
        if (!this.lastTickTimestamp) return Infinity;
        return (Date.now() - this.lastTickTimestamp) / 1000;
    }

    /** Is connection healthy enough to place new trades? */
    isHealthy(): boolean {
        return this.status === 'CONNECTED' && this.tickAgeSec() < STALE_TICK_THRESHOLD_MS / 1000;
    }

    async connect(): Promise<void> {
        this.intentionalDisconnect = false;
        this.setStatus('CONNECTING');

        const WS: typeof WebSocket | undefined =
            (typeof window !== 'undefined' && (window as any).WebSocket) ||
            (typeof globalThis !== 'undefined' && (globalThis as any).WebSocket);
        if (!WS) throw new Error('DerivClient: no WebSocket implementation found.');

        // Direct Deriv WebSocket connection. Authentication happens with authorize() after connect.
        const socketUrl = `${DERIV_WS_URL}${DERIV_DEFAULT_APP_ID ? `?app_id=${encodeURIComponent(DERIV_DEFAULT_APP_ID)}` : ''}`;
        const ws = new WS(socketUrl);

        ws.onclose = (ev: any) =>
            this.handleClose(`close code=${ev?.code} reason=${ev?.reason || 'n/a'}`);
        ws.onerror = (_ev: any) => {
            try { this.events.onDisconnect?.('websocket error'); } catch {}
        };

        let mod: any;
        try {
            // The browser keeps the stable DerivAPIBasic message vocabulary.
            // Authentication is performed directly against Deriv with authorize(token)
            // after the WebSocket connection opens.
            // @ts-ignore
            mod = await import('@deriv/deriv-api/dist/DerivAPIBasic');
        } catch (e: any) {
            throw new Error(`DerivClient: dynamic import failed — ${e?.message ?? e}`);
        }

        this.api = new mod.default({ connection: ws });

        try {
            if (this.token) {
                await this.api.authorize(this.token);
            }
        } catch (e: any) {
            throw new Error(`DerivClient: authorization failed — ${e?.message ?? e}`);
        }

        this.setStatus('CONNECTED', this.token ? 'authenticated Deriv Options API' : 'public Deriv Options market data');
        this.reconnectAttempt = 0;
        this.lastTickTimestamp = Date.now();
        this.startHeartbeat();
        this.startStalenessMonitor();
    }

    private startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(async () => {
            if (!this.api || this.status !== 'CONNECTED') return;
            try { await this.api.ping(); }
            catch {
                this.handleClose('heartbeat ping failed');
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    private stopHeartbeat() {
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    }

    private startStalenessMonitor() {
        this.stopStalenessMonitor();
        this.stalenessTimer = setInterval(() => {
            if (this.status !== 'CONNECTED') return;
            const ageMs = Date.now() - this.lastTickTimestamp;
            if (ageMs > STALE_TICK_THRESHOLD_MS) {
                this.setStatus('DEGRADED', `no ticks for ${(ageMs / 1000).toFixed(0)}s`);
                try { this.events.onTickStaleness?.(ageMs / 1000); } catch {}
            }
        }, 5000);
    }

    private stopStalenessMonitor() {
        if (this.stalenessTimer) { clearInterval(this.stalenessTimer); this.stalenessTimer = null; }
    }

    private handleClose(reason: string) {
        if (this.intentionalDisconnect) return;
        this.stopHeartbeat();
        this.stopStalenessMonitor();
        this.setStatus('DISCONNECTED', reason);
        try { this.events.onDisconnect?.(reason); } catch {}
        this.scheduleReconnect();
    }

    private scheduleReconnect() {
        if (this.intentionalDisconnect) return;
        if (MAX_RECONNECT_ATTEMPTS > 0 && this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
            this.setStatus('DISCONNECTED', `max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
            return;
        }
        this.reconnectAttempt++;
        this.reconnectCount++;
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped)
        const delay = Math.min(30_000, 1000 * Math.pow(2, this.reconnectAttempt - 1));
        const attemptLabel = MAX_RECONNECT_ATTEMPTS > 0
            ? `${this.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS}`
            : `${this.reconnectAttempt} (unlimited)`;
        this.setStatus('RECONNECTING', `attempt ${attemptLabel} in ${delay}ms`);

        this.reconnectTimer = setTimeout(async () => {
            try {
                await this.connect();
                // Re-subscribe all previously-tracked symbols
                const prev = Array.from(this.subs.values());
                this.subs.clear();
                for (const info of prev) {
                    try { await this.subscribeTicks(info.symbol, info.cb); }
                    catch (e: any) {
                        // Re-subscription failure -> next reconnect cycle handles it
                    }
                }
                try { this.events.onReconnect?.(this.reconnectAttempt); } catch {}
            } catch (e: any) {
                this.scheduleReconnect();
            }
        }, delay);
    }

    async subscribeTicks(symbol: string, cb: Callback<DerivTick>): Promise<void> {
        if (!this.api) throw new Error('DerivClient: not connected');
        const sub = this.api.subscribe({ ticks: symbol });
        sub.subscribe((res: any) => {
            const t = res?.tick;
            if (t) {
                this.lastTickTimestamp = Date.now();
                cb({ epoch: t.epoch, quote: t.quote, symbol: t.symbol });
            }
        });
        this.subs.set(`ticks:${symbol}`, { symbol, cb, sub });
    }

    /**
     * Fetch OHLC history.
     *
     * v5.5.5 NO-REPAINT — LAYER 1 (source).
     * `end: 'latest'` makes Deriv include the **currently-forming** bar as the
     * final element. Its high/low/close mutate on every tick, so any indicator
     * built from it repaints and can never be reproduced in a backtest.
     *
     * We therefore normalise here, at the single point where candles enter the
     * process: rows with non-finite OHLC are dropped, duplicate epochs from a
     * reconnect are collapsed (newest wins), order is restored, and every bar
     * that has not closed yet is excluded.
     *
     * `closedOnly = false` is available for chart/display callers that
     * legitimately want the live bar. Nothing in the decision pipeline uses it.
     */
    async getCandles(symbol: string, granularity = 60, count = 200, closedOnly = true) {
        if (!this.api) throw new Error('DerivClient: not connected');
        // Ask for one extra bar so that discarding the forming bar still leaves
        // `count` closed bars for the indicator warm-up window.
        const requested = closedOnly ? count + 1 : count;
        const res = await this.api.ticksHistory({
            ticks_history: symbol, adjust_start_time: 1, count: requested, end: 'latest',
            granularity, style: 'candles',
        });
        const raw = res.candles || [];
        if (!closedOnly) return raw;

        // Coerce to numbers BEFORE guarding so NaN payloads are detected here
        // rather than poisoning a rolling indicator later.
        const normalised = raw.map((c: any) => ({
            epoch: Number(c?.epoch),
            open: Number(c?.open), high: Number(c?.high),
            low: Number(c?.low), close: Number(c?.close),
        }));

        const report = guardCandles(normalised, {
            timeframeSec: granularity,
            label: symbol,
        });
        this.lastCandleGuard = {
            symbol,
            droppedForming: report.droppedForming,
            droppedInvalid: report.droppedInvalid,
            droppedDuplicate: report.droppedDuplicate,
            reason: report.reason,
        };
        // Trim back to the caller's requested length (newest `count` closed bars).
        return report.candles.slice(-count);
    }

    /** Diagnostics from the most recent `getCandles` guard pass (overlay/audit). */
    public lastCandleGuard?: {
        symbol: string;
        droppedForming: number;
        droppedInvalid: number;
        droppedDuplicate: number;
        reason: string;
    };

    async getTicks(symbol: string, count = 500) {
        if (!this.api) throw new Error('DerivClient: not connected');
        const res = await this.api.ticksHistory({
            ticks_history: symbol, adjust_start_time: 1, count, end: 'latest', style: 'ticks',
        });
        return res.history?.prices?.map((p: any, i: number) =>
            ({ epoch: res.history.times[i], quote: Number(p) })) ?? [];
    }

    async buyMultiplier(p: DerivBuyMultiplier): Promise<DerivBuyResult> {
        if (!this.isHealthy()) {
            throw new Error(`DerivClient.buyMultiplier: connection ${this.status} — refusing trade`);
        }
        const params: any = {
            buy: 1, price: p.stake,
            parameters: {
                amount: p.stake, basis: 'stake',
                contract_type: p.direction === 'UP' ? 'MULTUP' : 'MULTDOWN',
                currency: 'USD', symbol: p.symbol, multiplier: p.multiplier,
            },
        };
        if (p.stopLossPips)   params.parameters.limit_order = { ...params.parameters.limit_order, stop_loss:   p.stopLossPips };
        if (p.takeProfitPips) params.parameters.limit_order = { ...params.parameters.limit_order, take_profit: p.takeProfitPips };
        const r = await this.api.buy(params);
        return { contractId: String(r.buy.contract_id), buyPrice: r.buy.buy_price, payout: r.buy.payout };
    }

    async buyBinary(p: DerivBuyBinary): Promise<DerivBuyResult> {
        if (!this.isHealthy()) {
            throw new Error(`DerivClient.buyBinary: connection ${this.status} — refusing trade`);
        }
        const params: any = {
            buy: 1, price: p.stake,
            parameters: {
                amount: p.stake, basis: 'stake', contract_type: p.contractType,
                currency: 'USD', symbol: p.symbol,
                duration: p.durationTicks ?? 5, duration_unit: 't',
            },
        };
        if (p.barrier !== undefined)    params.parameters.barrier = String(p.barrier);
        if (p.targetDigit !== undefined) params.parameters.barrier = String(p.targetDigit);
        const r = await this.api.buy(params);
        return { contractId: String(r.buy.contract_id), buyPrice: r.buy.buy_price, payout: r.buy.payout };
    }

    async sellContract(contractId: string): Promise<number> {
        if (!this.api) throw new Error('DerivClient.sellContract: not connected');
        const r = await this.api.sell({ sell: contractId, price: 0 });
        return r.sell.sold_for ?? 0;
    }

    disconnect() {
        this.intentionalDisconnect = true;
        this.stopHeartbeat();
        this.stopStalenessMonitor();
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.subs.forEach(info => { try { info.sub.unsubscribe?.(); } catch {} });
        this.subs.clear();
        try { this.api?.disconnect?.(); } catch { /* idempotent */ }
        this.api = null;
        this.setStatus('DISCONNECTED', 'manual');
    }
}

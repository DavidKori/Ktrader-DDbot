/**
 * TradeWithKen Engine Bootstrap
 * =============================
 * Instantiates the Orchestrator lazily on first user click ("Start Auto-Trade")
 * and pins it to `window.__TWK_ENGINE__`. Publishes every orchestrator event
 * to the overlay bus so the UI updates live.
 *
 * The orchestrator connects to Deriv WebSocket:
 *   - WITHOUT token   → public tick scan only (signals visible in overlay)
 *   - WITH token      → real trades executed (token pulled from localStorage.authToken)
 *
 * Base stake is read from localStorage.twkBaseStake (default $1).
 */

import { Orchestrator } from '@/ai/lifecycle/orchestrator';
import { executeManualOrder, ManualOrderRequest } from '@/ai/execution/manual-order-router';
import { getAppId } from '@/components/shared';
import { safeGetItem } from '@/utils/safe-storage';

const ENG_KEY = '__TWK_ENGINE__';
const BUS_KEY = '__TWK_BUS__';
const STAKE_KEY = 'twkBaseStake';

function bus(): any { return (window as any)[BUS_KEY]; }

function publish(payload: { type: string; message?: string; [k: string]: any }) {
    try {
        const b = bus();
        if (b?.publish) b.publish({ ...payload, ts: Date.now() });
    } catch { /* noop */ }
}

/**
 * Return the singleton engine, creating it if needed. Idempotent.
 * Called by the overlay's "Start Auto-Trade" button.
 */
export function getOrCreateEngine(): Orchestrator {
    const w = window as any;
    if (w[ENG_KEY] instanceof Orchestrator) return w[ENG_KEY];

    let baseStake = 1;
    const rawStake = safeGetItem(STAKE_KEY);
    if (rawStake !== null) {
        const n = Number(rawStake);
        if (isFinite(n) && n > 0) baseStake = n;
    }

    // AuthWrapper stores the currently active Deriv authorization token in
    // browser storage after the OAuth callback completes so direct WebSocket
    // authorization can proceed on the client.
    const storedToken = safeGetItem('authToken');
    const token = storedToken && storedToken !== 'null' ? storedToken : '';

    const eng = new Orchestrator(token, {
        // Keep the orchestrator's app id aligned with the classic Deriv
        // WebSocket endpoint used by the live trading transport.
        appId: getAppId(),
        baseStake,
        symbols: [
            'frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD',
            'R_100', 'R_75', '1HZ100V',
        ],
        pollMs: 4000,
    });

    eng.listeners.add(ev => {
        publish({
            type: ev.type, symbol: ev.symbol, message: ev.message,
            pnl: ev.pnl, data: ev.data,
        });
    });

    w[ENG_KEY] = eng;
    publish({
        type: 'log',
        message: `engine booted · Deriv classic API · stake=$${baseStake.toFixed(2)} · session=${token ? 'present' : 'absent'}`,
    });
    return eng;
}

/**
 * Attach a global "Start" hook so the overlay button can drive the engine
 * even without importing this module directly (it's loaded once from main.tsx).
 */
export function installEngineHook(): void {
    if (typeof window === 'undefined') return;
    const w = window as any;
    if (w.__TWK_ENGINE_HOOK_INSTALLED__) return;
    w.__TWK_ENGINE_HOOK_INSTALLED__ = true;

    // Expose a factory the overlay calls when the user clicks "Start"
    w.__TWK_START__ = async () => {
        try {
            const eng = getOrCreateEngine();

            // ── v5.5.5 AUTH FIX ──
            // `getOrCreateEngine()` is a singleton and captured `authToken` ONCE,
            // at first construction. Real-world sequence on a fresh browser:
            //
            //   1. user lands on the app, overlay mounts, engine is created
            //      → localStorage.authToken is EMPTY → token = ''
            //   2. user completes Deriv OAuth → /callback writes authToken
            //   3. user clicks "Start Auto-Trade"
            //      → the SAME singleton is reused, still holding token = ''
            //      → DerivClient never calls api.authorize(...)
            //      → engine runs in signals-only mode and every live entry is
            //        silently refused. The UI shows scanning but never trades.
            //
            // Fix: re-read the token immediately before starting, and if it has
            // appeared (or changed accounts) since construction, push it into the
            // orchestrator and force a reconnect so `authorize` actually runs.
            const fresh = safeGetItem('authToken');
            const freshToken = fresh && fresh !== 'null' ? fresh : '';
            const current = (eng as any).token ?? '';

            if (freshToken !== current) {
                (eng as any).token = freshToken;
                // A live socket authorised with the OLD identity must be torn down,
                // otherwise trades would route to the previous account.
                if ((eng as any).running) {
                    publish({ type: 'log', message: 'auth changed — reconnecting engine with new token' });
                    try { await eng.stop(); } catch { /* ignore */ }
                }
                publish({
                    type: 'log',
                    message: `auth token ${freshToken ? 'attached' : 'cleared'} (was ${current ? 'present' : 'absent'})`,
                });
            }

            if (!(eng as any).running) await eng.start();
            publish({
                type: 'log',
                message: `engine.start() OK — mode=${freshToken ? 'LIVE-capable' : 'signals-only (no auth)'}`,
            });
            return true;
        } catch (e: any) {
            publish({ type: 'error', message: `engine.start failed: ${e?.message ?? e}` });
            return false;
        }
    };
    w.__TWK_STOP__ = async () => {
        try {
            const eng = w[ENG_KEY] as Orchestrator | undefined;
            if (eng) await eng.stop();
            publish({ type: 'log', message: 'engine.stop() OK' });
            return true;
        } catch (e: any) {
            publish({ type: 'error', message: `engine.stop failed: ${e?.message ?? e}` });
            return false;
        }
    };

    // Manual order path — called by the overlay's per-instrument BUY/SELL/CALL/PUT buttons.
    // Routes through the product-family-aware manual router so binary and forex
    // NEVER share the same execution path.
    w.__TWK_MANUAL__ = async (req: ManualOrderRequest) => {
        try {
            const eng = getOrCreateEngine() as any;

            // v5.5.5 AUTH FIX (same singleton staleness as __TWK_START__).
            // The manual router already re-reads `authToken`, but the ENGINE's
            // DerivClient may still be authorised with an older/absent identity.
            // Without this, a manual BUY passes the router's auth gate and is
            // then rejected by the exchange (or, worse, routed to the previous
            // account).
            const t2 = safeGetItem('authToken');
            const token = t2 && t2 !== 'null' ? t2 : '';
            if (token !== (eng.token ?? '')) {
                eng.token = token;
                if (eng.running) {
                    publish({ type: 'log', message: 'auth changed — reconnecting before manual order' });
                    try { await eng.stop(); } catch { /* ignore */ }
                }
            }

            // Ensure engine is connected so deriv client is ready
            if (!eng.running) await eng.start();
            const deriv = eng?.deriv ?? null;
            const res = await executeManualOrder(deriv, token, req);
            publish({
                type: res.ok ? 'trade_open' : 'blocked',
                symbol: req.symbol,
                message: res.ok
                    ? `manual ${req.kind}:${(req as any).action} filled cid=${res.contractId}`
                    : `manual blocked: ${res.reason} — ${res.message ?? ''}`,
                data: res,
            });
            return res;
        } catch (e: any) {
            publish({ type: 'error', symbol: req.symbol, message: `manual error: ${e?.message ?? e}` });
            return { ok: false, reason: 'exchange_error', message: e?.message ?? String(e) };
        }
    };

    // Per-symbol AUTO opt-in — remembered on the orchestrator so scan cycles
    // can honour the user's choice to disable AI trading on specific instruments.
    w.__TWK_SET_MODE__ = (symbol: string, mode: 'MANUAL' | 'AUTO') => {
        try {
            const eng = w[ENG_KEY] as any;
            if (!eng) return;
            eng.autoEnabled = eng.autoEnabled || new Map<string, boolean>();
            eng.autoEnabled.set(symbol, mode === 'AUTO');
            publish({ type: 'log', symbol, message: `mode=${mode}` });
        } catch { /* ignore */ }
    };

    // Subscribe to bus so button clicks (engine_start / engine_stop events) drive the engine
    const b = bus();
    if (b?.subscribe) {
        b.subscribe(async (ev: any) => {
            if (ev.type === 'engine_start') await w.__TWK_START__();
            if (ev.type === 'engine_stop')  await w.__TWK_STOP__();
        });
    }

    publish({ type: 'log', message: 'engine hook installed — click "Start Auto-Trade" to begin scanning' });
}

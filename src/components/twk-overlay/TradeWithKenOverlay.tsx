/**
 * TradeWithKen AI Overlay — v5.4.1
 * =================================
 * Adds:
 *   - Base-stake input (persisted to localStorage.twkBaseStake)
 *   - Live "engine status" (scanning / ticks/sec / last signal)
 *   - Public tick scanning works BEFORE login (auth only needed for real trades)
 *   - Direct wire to window.__TWK_ENGINE__ (set by orchestrator boot in main.tsx)
 */

import React from 'react';
import ReactDOM from 'react-dom';
import {
    ManualAutoToggle, InstrumentDescriptor, InstrumentStatus, TradeMode,
} from './ManualAutoToggle';
import {
    DEFAULT_INSTRUMENTS, loadPrefs, savePrefs, mapEventToStatus, InstrumentPrefs,
} from './instrument-state';

const HOST_ID  = 'twk-ai-root';
const BUS_KEY  = '__TWK_BUS__';
const ENG_KEY  = '__TWK_ENGINE__';
const STAKE_KEY = 'twkBaseStake';
const Z_INDEX  = 2147483000;

const buttonStyle: React.CSSProperties = {
    position: 'fixed', right: '20px', bottom: '20px',
    width: '58px', height: '58px', borderRadius: '50%', border: 'none',
    background: 'linear-gradient(135deg, #ff6a00 0%, #ff2e63 100%)',
    color: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
    boxShadow: '0 8px 24px rgba(255,46,99,.35), 0 0 0 3px rgba(255,255,255,.15)',
    zIndex: Z_INDEX, display: 'flex', alignItems: 'center', justifyContent: 'center', userSelect: 'none',
};

const panelStyle: React.CSSProperties = {
    position: 'fixed', right: '20px', bottom: '88px',
    width: '360px', maxHeight: '620px',
    borderRadius: '16px', background: 'rgba(15, 17, 26, 0.96)',
    color: '#e6e9ef', fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
    fontSize: '13px', boxShadow: '0 24px 64px rgba(0,0,0,.55)',
    border: '1px solid rgba(255,255,255,.08)', zIndex: Z_INDEX,
    overflow: 'hidden', display: 'flex', flexDirection: 'column',
};

const headerStyle: React.CSSProperties = {
    padding: '14px 16px',
    background: 'linear-gradient(135deg, #ff6a00 0%, #ff2e63 100%)',
    color: '#fff', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
};

const rowStyle: React.CSSProperties = {
    display: 'flex', justifyContent: 'space-between',
    padding: '7px 14px', borderBottom: '1px solid rgba(255,255,255,.05)', fontSize: 12,
};

const inputStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,.08)', color: '#fff', border: '1px solid rgba(255,255,255,.15)',
    borderRadius: 6, padding: '4px 8px', width: 90, textAlign: 'right',
    fontSize: 12, fontFamily: 'inherit',
};

export interface TelemetryEvent {
    type: string; symbol?: string; message?: string;
    mode?: 'LIVE' | 'SHADOW' | 'REDUCED' | 'BLOCKED';
    bucket?: string; stake?: number; pnl?: number; tf?: 'M1' | 'M5';
    ts: number; [k: string]: any;
}

interface Bus {
    events: TelemetryEvent[]; listeners: Set<(e: TelemetryEvent) => void>;
    publish: (e: TelemetryEvent) => void;
    subscribe: (fn: (e: TelemetryEvent) => void) => () => void;
}

function ensureBus(): Bus {
    const w = window as any;
    if (w[BUS_KEY]) return w[BUS_KEY] as Bus;
    const bus: Bus = {
        events: [], listeners: new Set(),
        publish(e) {
            this.events.push(e);
            if (this.events.length > 200) this.events.shift();
            this.listeners.forEach(fn => { try { fn(e); } catch { /* noop */ } });
        },
        subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    };
    w[BUS_KEY] = bus;
    return bus;
}

function ensureHost(): HTMLElement {
    let host = document.getElementById(HOST_ID);
    if (host) return host;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = [
        'position:fixed !important', 'inset:auto 0 0 auto !important',
        `z-index:${Z_INDEX} !important`, 'pointer-events:none !important',
        'width:0 !important', 'height:0 !important', 'overflow:visible !important',
    ].join(';');
    document.body.appendChild(host);
    return host;
}

let observerStarted = false;
function watchAndResurrect() {
    if (observerStarted) return;
    observerStarted = true;
    const obs = new MutationObserver(() => {
        if (!document.getElementById(HOST_ID)) ensureHost();
    });
    obs.observe(document.body, { childList: true, subtree: false });
}

const StatusRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
    <div style={rowStyle}>
        <span style={{ opacity: 0.65 }}>{label}</span>
        <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
);

type OverlayTab = 'engine' | 'instruments';

const OverlayPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const bus = React.useMemo(() => ensureBus(), []);
    const [tab, setTab] = React.useState<OverlayTab>('engine');
    const [events, setEvents] = React.useState<TelemetryEvent[]>(() => bus.events.slice(-20));
    const [authed, setAuthed] = React.useState<boolean>(false);
    const [loginId, setLoginId] = React.useState<string>('—');
    const [engineRunning, setEngineRunning] = React.useState<boolean>(false);
    const [ticksSeen, setTicksSeen] = React.useState<number>(0);
    const [stake, setStake] = React.useState<number>(() => {
        try {
            const v = Number(localStorage.getItem(STAKE_KEY) ?? '1');
            return isFinite(v) && v > 0 ? v : 1;
        } catch { return 1; }
    });

    // ---- per-instrument state -------------------------------------------
    const instruments: InstrumentDescriptor[] = DEFAULT_INSTRUMENTS;
    const [prefs, setPrefs] = React.useState<Record<string, InstrumentPrefs>>(() => {
        const out: Record<string, InstrumentPrefs> = {};
        for (const ins of instruments) out[ins.symbol] = loadPrefs(ins.symbol, ins.family, stake);
        return out;
    });
    const [statuses, setStatuses] = React.useState<Record<string, InstrumentStatus>>(() => {
        const out: Record<string, InstrumentStatus> = {};
        for (const ins of instruments) out[ins.symbol] = 'idle';
        return out;
    });

    const updatePrefs = React.useCallback((sym: string, patch: Partial<InstrumentPrefs>) => {
        setPrefs(prev => {
            const next = { ...prev, [sym]: { ...prev[sym], ...patch } };
            savePrefs(sym, next[sym]);
            // Announce AUTO mode change so orchestrator can honour per-symbol opt-in
            if (patch.mode) {
                bus.publish({
                    type: patch.mode === 'AUTO' ? 'auto_enable' : 'auto_disable',
                    symbol: sym, message: `mode=${patch.mode}`, ts: Date.now(),
                });
                try {
                    const w = window as any;
                    if (w.__TWK_SET_MODE__) w.__TWK_SET_MODE__(sym, patch.mode);
                } catch { /* ignore */ }
            }
            return next;
        });
    }, [bus]);

    const fireManual = React.useCallback(
        (sym: string, family: 'binary' | 'forex', action: string) => {
            const p = prefs[sym];
            if (!p) return;
            const w = window as any;
            const req: any = family === 'binary'
                ? { kind: 'binary', symbol: sym, action, stake: p.stake, durationTicks: p.durationTicks }
                : { kind: 'forex',  symbol: sym, action, stake: p.stake, multiplier: p.multiplier,
                    stopLossPips: p.stopLossPips || undefined,
                    takeProfitPips: p.takeProfitPips || undefined };
            bus.publish({
                type: 'manual_click', symbol: sym,
                message: `${family}:${action} $${p.stake}`, ts: Date.now(),
            });
            if (typeof w.__TWK_MANUAL__ === 'function') {
                w.__TWK_MANUAL__(req).then((r: any) => {
                    bus.publish({
                        type: r?.ok ? 'trade_open' : 'blocked',
                        symbol: sym,
                        message: r?.ok ? `manual filled cid=${r.contractId}` : `blocked: ${r?.reason} ${r?.message ?? ''}`,
                        ts: Date.now(),
                    });
                }).catch((e: any) => {
                    bus.publish({ type: 'error', symbol: sym, message: `manual error: ${e?.message ?? e}`, ts: Date.now() });
                });
            } else {
                bus.publish({
                    type: 'blocked', symbol: sym,
                    message: 'engine not started — click Start Auto-Trade first',
                    ts: Date.now(),
                });
            }
        },
        [prefs, bus],
    );

    React.useEffect(() => {
        try {
            const t = localStorage.getItem('authToken');
            const lid = localStorage.getItem('active_loginid');
            setAuthed(!!(t && t !== 'null'));
            setLoginId(lid && lid !== 'null' ? lid : '—');
        } catch { /* ignore */ }
        const unsub = bus.subscribe(e => {
            setEvents(prev => [...prev.slice(-19), e]);
            if (e.type === 'engine_start') setEngineRunning(true);
            if (e.type === 'engine_stop')  setEngineRunning(false);
            if (e.type === 'tick') setTicksSeen(n => n + 1);
            // Update per-symbol status if the event is symbol-scoped
            if (e.symbol) {
                const mapped = mapEventToStatus(e.type);
                if (mapped) {
                    setStatuses(prev => (prev[e.symbol!] === mapped ? prev : { ...prev, [e.symbol!]: mapped }));
                }
            }
        });
        return unsub;
    }, [bus]);

    // Persist stake changes to localStorage + push to engine if present
    React.useEffect(() => {
        try { localStorage.setItem(STAKE_KEY, String(stake)); } catch {}
        const eng = (window as any)[ENG_KEY];
        if (eng?.execution?.setBaseStake) {
            try { eng.execution.setBaseStake(stake); } catch {}
        }
    }, [stake]);

    const latest = events[events.length - 1];
    const stats = React.useMemo(() => {
        const closed = events.filter(e => e.type === 'trade_close');
        const wins = closed.filter(e => (e.pnl ?? 0) > 0).length;
        const losses = closed.length - wins;
        const net = closed.reduce((s, e) => s + (e.pnl ?? 0), 0);
        const wr = closed.length ? wins / closed.length : 0;
        return { wins, losses, net, wr, n: closed.length };
    }, [events]);

    const toggleEngine = React.useCallback(async (run: boolean) => {
        const eng = (window as any)[ENG_KEY];
        try {
            if (run) {
                bus.publish({ type: 'engine_start', message: 'user-start', ts: Date.now() });
                if (eng?.start) {
                    await eng.start();
                    bus.publish({ type: 'log', message: 'engine.start() OK — scanning ticks', ts: Date.now() });
                } else {
                    bus.publish({ type: 'log', message: 'engine not yet bootstrapped (see main.tsx boot log)', ts: Date.now() });
                }
            } else {
                bus.publish({ type: 'engine_stop', message: 'user-stop', ts: Date.now() });
                if (eng?.stop) await eng.stop();
            }
        } catch (e: any) {
            bus.publish({ type: 'error', message: `engine toggle failed: ${e?.message ?? e}`, ts: Date.now() });
        }
    }, [bus]);

    return (
        <div id="twk-ai-panel" style={{ ...panelStyle, pointerEvents: 'auto' }}>
            <div style={headerStyle}>
                <span>🤖 TradeWithKen AI</span>
                <span onClick={onClose} style={{ cursor: 'pointer', opacity: 0.85 }}>✕</span>
            </div>

            <div style={{ padding: '4px 0', background: 'rgba(255,255,255,.02)' }}>
                <StatusRow label="Engine" value={
                    <span style={{ color: engineRunning ? '#4ade80' : '#94a3b8' }}>
                        {engineRunning ? 'RUNNING · scanning' : 'stopped'}
                    </span>
                } />
                <StatusRow label="Deriv auth" value={
                    authed ? <span style={{ color: '#4ade80' }}>connected</span>
                           : <span style={{ color: '#f97316' }}>signals only (login required for real trades)</span>
                } />
                <StatusRow label="Account" value={loginId} />
                <StatusRow label="Ticks received" value={ticksSeen} />
                <StatusRow label="Signals seen" value={events.filter(e => e.type === 'signal' || e.type === 'trade_open').length} />
                <StatusRow label="Trades closed" value={stats.n} />
                <StatusRow label="Win rate" value={`${(stats.wr * 100).toFixed(1)}%`} />
                <StatusRow label="Net P&L" value={<span style={{ color: stats.net >= 0 ? '#4ade80' : '#f87171' }}>${stats.net.toFixed(2)}</span>} />
                <StatusRow label="Base stake ($)" value={
                    <input type="number" min={0.35} step={0.5} value={stake}
                        onChange={e => setStake(Math.max(0.35, Number(e.target.value) || 1))}
                        style={inputStyle} />
                } />
                {latest && <StatusRow label="Last event" value={latest.type + (latest.symbol ? ` · ${latest.symbol}` : '')} />}
                {latest?.tf && <StatusRow label="Active TF" value={latest.tf} />}
                {latest?.mode && <StatusRow label="Mode" value={latest.mode} />}
                {latest?.bucket && <StatusRow label="Bucket" value={latest.bucket} />}
            </div>

            <div style={{ padding: '10px 14px', display: 'flex', gap: 8 }}>
                <button
                    onClick={() => toggleEngine(true)}
                    disabled={engineRunning}
                    style={{ flex: 1, padding: '9px 12px', borderRadius: 10, border: 'none',
                        background: engineRunning ? '#374151' : '#22c55e',
                        color: engineRunning ? '#9ca3af' : '#0b1020', fontWeight: 700,
                        cursor: engineRunning ? 'not-allowed' : 'pointer' }}
                >{engineRunning ? 'Running…' : 'Start Auto-Trade'}</button>
                <button
                    onClick={() => toggleEngine(false)}
                    disabled={!engineRunning}
                    style={{ flex: 1, padding: '9px 12px', borderRadius: 10,
                        border: '1px solid rgba(255,255,255,.15)',
                        background: 'transparent', color: '#f87171', fontWeight: 700,
                        cursor: engineRunning ? 'pointer' : 'not-allowed', opacity: engineRunning ? 1 : 0.5 }}
                >Stop</button>
            </div>

            {/* Tab bar */}
            <div style={{ display: 'flex', borderTop: '1px solid rgba(255,255,255,.05)', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                <button
                    onClick={() => setTab('engine')}
                    style={{
                        flex: 1, padding: '8px', border: 'none', cursor: 'pointer',
                        background: tab === 'engine' ? 'rgba(255,255,255,.06)' : 'transparent',
                        color: tab === 'engine' ? '#fff' : '#aaa',
                        fontWeight: 700, fontSize: 12, borderBottom: tab === 'engine' ? '2px solid #ff2e63' : '2px solid transparent',
                    }}
                >Engine</button>
                <button
                    onClick={() => setTab('instruments')}
                    style={{
                        flex: 1, padding: '8px', border: 'none', cursor: 'pointer',
                        background: tab === 'instruments' ? 'rgba(255,255,255,.06)' : 'transparent',
                        color: tab === 'instruments' ? '#fff' : '#aaa',
                        fontWeight: 700, fontSize: 12, borderBottom: tab === 'instruments' ? '2px solid #ff2e63' : '2px solid transparent',
                    }}
                >Instruments</button>
            </div>

            {tab === 'engine' && (
                <div style={{ overflowY: 'auto', maxHeight: 220 }}>
                    {events.slice().reverse().slice(0, 20).map((e, i) => (
                        <div key={i} style={{ padding: '6px 14px', fontSize: 11, opacity: 0.85, borderBottom: '1px dashed rgba(255,255,255,.04)' }}>
                            <span style={{ opacity: 0.5 }}>{new Date(e.ts).toLocaleTimeString()}</span>
                            {' · '}
                            <b>{e.type}</b>
                            {e.symbol ? <> · {e.symbol}</> : null}
                            {e.message ? <> · {e.message}</> : null}
                            {typeof e.pnl === 'number' ? <> · pnl=${e.pnl.toFixed(2)}</> : null}
                        </div>
                    ))}
                    {events.length === 0 && (
                        <div style={{ padding: '10px 14px', fontSize: 11, opacity: 0.6 }}>
                            Waiting for engine events… Click <b>Start Auto-Trade</b>.
                        </div>
                    )}
                </div>
            )}

            {tab === 'instruments' && (
                <div style={{ overflowY: 'auto', maxHeight: 340, padding: '10px 12px' }}>
                    {instruments.map(ins => {
                        const p = prefs[ins.symbol];
                        const s = statuses[ins.symbol] ?? 'idle';
                        return (
                            <ManualAutoToggle
                                key={ins.symbol}
                                instrument={ins}
                                status={s}
                                mode={p.mode}
                                stake={p.stake}
                                durationTicks={p.durationTicks}
                                multiplier={p.multiplier}
                                stopLossPips={p.stopLossPips}
                                takeProfitPips={p.takeProfitPips}
                                isAuthed={authed}
                                onModeChange={m => updatePrefs(ins.symbol, { mode: m as TradeMode })}
                                onStakeChange={n => updatePrefs(ins.symbol, { stake: n })}
                                onDurationChange={n => updatePrefs(ins.symbol, { durationTicks: n })}
                                onMultiplierChange={n => updatePrefs(ins.symbol, { multiplier: n })}
                                onSlPipsChange={n => updatePrefs(ins.symbol, { stopLossPips: n })}
                                onTpPipsChange={n => updatePrefs(ins.symbol, { takeProfitPips: n })}
                                onManualBinary={a => fireManual(ins.symbol, 'binary', a)}
                                onManualForex={ a => fireManual(ins.symbol, 'forex',  a)}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
};

const TradeWithKenOverlay: React.FC = () => {
    const [open, setOpen] = React.useState(false);
    const [host, setHost] = React.useState<HTMLElement | null>(null);

    React.useEffect(() => {
        if (typeof document === 'undefined') return;
        setHost(ensureHost());
        watchAndResurrect();
    }, []);

    if (!host) return null;

    return ReactDOM.createPortal(
        <>
            <button
                id="twk-ai-button" aria-label="TradeWithKen AI" title="TradeWithKen AI"
                onClick={() => setOpen(v => !v)}
                style={{ ...buttonStyle, pointerEvents: 'auto' }}
            >
                <span style={{ fontSize: 22 }}>🤖</span>
            </button>
            {open && <OverlayPanel onClose={() => setOpen(false)} />}
        </>,
        host,
    );
};

export default TradeWithKenOverlay;

export function publishTelemetry(e: Omit<TelemetryEvent, 'ts'>) {
    if (typeof window === 'undefined') return;
    ensureBus().publish({ ...e, ts: Date.now() });
}

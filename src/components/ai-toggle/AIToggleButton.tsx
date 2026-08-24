/**
 * AI Toggle Button — Production v5
 * --------------------------------
 * Wires all production features:
 *   • Manual base-stake input (locked once started)
 *   • Mode pill (VIRTUAL · LIVE · LIVE_MARTINGALE)
 *   • Risk-state pill (SAFE · CAUTION · PAUSED)
 *   • Recovery pill (when active)
 *   • Scanner button
 *   • Analytics button (Performance Dashboard)
 *   • Emergency Controls dropdown
 *   • XML download chip
 *   • Bubbling profit popups
 */
import React, { useEffect, useRef, useState } from 'react';
import { Orchestrator, OrchestratorEvent }    from '../../ai/lifecycle/orchestrator';
import { DERIV_DEFAULT_APP_ID }                from '../../ai/lifecycle/deriv-client';
import { downloadXML }                          from '../../ai/xml/xml-generator';
import ProfitPopup, { ProfitPopupHandle }      from '../profit-popup/ProfitPopup';
import MarketScanner                            from '../scanner/MarketScanner';
import AnalyticsDashboard                       from '../analytics/AnalyticsDashboard';
import EmergencyControls                        from '../emergency/EmergencyControls';

interface Props {
    token: string;
    symbols?: string[];
    accountBalance?: number;
    appId?: number;
}

const KEYFRAMES = `@keyframes twk-pulse {
  0% { box-shadow: 0 0 0 0 rgba(125,255,115,0.5); }
  70% { box-shadow: 0 0 0 14px rgba(125,255,115,0); }
  100% { box-shadow: 0 0 0 0 rgba(125,255,115,0); }
}`;

const styles = {
    btn: (active: boolean, disabled: boolean): React.CSSProperties => ({
        display: 'inline-flex', alignItems: 'center', gap: 10,
        padding: '12px 22px', borderRadius: 999, border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 14, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: active ? '#0d0818' : '#fff',
        background: disabled ? 'rgba(99,102,241,0.25)'
            : active ? 'linear-gradient(90deg, #43f3ff, #7dff73)'
                     : 'linear-gradient(135deg, #7c3aed, #4c1d95)',
        opacity: disabled ? 0.6 : 1,
        boxShadow: active
            ? '0 0 0 4px rgba(125,255,115,0.18), 0 10px 30px rgba(67,243,255,0.25)'
            : '0 8px 26px rgba(124,58,237,0.45)',
        animation: active ? 'twk-pulse 1.6s infinite' : 'none',
        transition: 'all .2s ease',
    }),
    pill: (color: string): React.CSSProperties => ({
        padding: '6px 12px', borderRadius: 999, border: `1px solid ${color}`,
        color, fontSize: 11, fontWeight: 800, letterSpacing: '0.10em',
        textTransform: 'uppercase', background: 'rgba(0,0,0,0.30)',
    }),
    secondary: { padding: '8px 14px', borderRadius: 999,
                 border: '1px solid rgba(255,255,255,0.15)',
                 background: 'rgba(255,255,255,0.04)', color: '#f4f0ff',
                 cursor: 'pointer', fontWeight: 600, fontSize: 13 } as React.CSSProperties,
    stakeInput: (locked: boolean): React.CSSProperties => ({
        width: 110, padding: '10px 12px', borderRadius: 10,
        border: '1px solid rgba(255,255,255,0.15)',
        background: locked ? 'rgba(67,243,255,0.06)' : 'rgba(255,255,255,0.04)',
        color: '#f4f0ff', fontSize: 14, fontWeight: 700,
        textAlign: 'right', outline: 'none',
    }),
    stakeWrap: { display: 'inline-flex', alignItems: 'center', gap: 8,
                 background: 'rgba(255,255,255,0.04)',
                 border: '1px solid rgba(255,255,255,0.12)',
                 borderRadius: 12, padding: '6px 10px' } as React.CSSProperties,
    panel: { marginTop: 14, padding: 16, borderRadius: 18,
             background: 'rgba(18,13,34,0.7)', border: '1px solid rgba(255,255,255,0.1)',
             color: '#f4f0ff', backdropFilter: 'blur(14px)',
             boxShadow: '0 18px 40px rgba(0,0,0,0.35)' } as React.CSSProperties,
    log:   { maxHeight: 220, overflowY: 'auto', marginTop: 12,
             fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12,
             padding: 10, borderRadius: 12, background: '#090710',
             border: '1px solid rgba(255,255,255,0.06)' } as React.CSSProperties,
};

const modeColor = (m: string) =>
    m === 'VIRTUAL' ? '#facc15' : m === 'LIVE_MARTINGALE' ? '#a855f7' : m === 'LIVE' ? '#22c55e' : '#9ca3af';
const riskColor = (r: string) =>
    r === 'PAUSED' ? '#ef4444' : r === 'CAUTION' ? '#facc15' : '#22c55e';

export const AIToggleButton: React.FC<Props> = ({
    token, symbols, accountBalance = 100, appId = DERIV_DEFAULT_APP_ID,
}) => {
    const [stakeStr, setStakeStr] = useState('1.00');
    const [stakeLocked, setStakeLocked] = useState(false);
    const [running, setRunning]   = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [scannerOpen, setScannerOpen] = useState(false);
    const [analyticsOpen, setAnalyticsOpen] = useState(false);
    const [stats, setStats] = useState({ trades: 0, wins: 0, losses: 0, pnl: 0, virtualTrades: 0, liveTrades: 0 });
    const [execSnap, setExecSnap] = useState<any>({
        mode: 'VIRTUAL', riskState: 'SAFE', baseStake: 1, nextStake: 1, martingaleLevel: 0,
        martingaleEligible: false, sample: 0, virtualWinRate: 0,
        consecutiveLosses: 0, consecutiveWins: 0, dailyPnL: 0, accountBalance: 0,
    });
    const [recoverySnap, setRecoverySnap] = useState<any>({ active: false, reason: 'normal' });
    const [lastEvent, setLastEvent]   = useState<string>('idle');
    const [logs, setLogs]             = useState<OrchestratorEvent[]>([]);
    const [lastXML, setLastXML]       = useState<{ symbol: string; xml: string } | null>(null);
    const orchRef                     = useRef<Orchestrator | null>(null);
    const popupRef                    = useRef<ProfitPopupHandle>(null);

    useEffect(() => {
        if (typeof document === 'undefined') return;
        if (!document.getElementById('twk-keyframes')) {
            const s = document.createElement('style');
            s.id = 'twk-keyframes'; s.textContent = KEYFRAMES;
            document.head.appendChild(s);
        }
    }, []);

    /**
     * Cleanup on unmount: if the user navigates away while the AI engine is
     * running, stop the orchestrator so we don't leak the WebSocket, the
     * setInterval poll loop, the Deriv subscriptions, or the listener set.
     */
    useEffect(() => {
        return () => {
            const orch = orchRef.current;
            if (orch) {
                orch.stop().catch(() => { /* best-effort teardown */ });
                orchRef.current = null;
            }
        };
    }, []);

    /**
     * Push account-balance prop changes into the running orchestrator so the
     * risk + execution engines see the live balance, not the snapshot at
     * start time. baseStake is still locked — only balance is propagated.
     */
    useEffect(() => {
        orchRef.current?.setBalance(accountBalance);
    }, [accountBalance]);

    const parsedStake = (() => {
        const n = Number(stakeStr);
        return Number.isFinite(n) && n >= 0.35 ? n : NaN;
    })();
    const canStart = !running && !!token && Number.isFinite(parsedStake);

    const toggle = async () => {
        if (running) {
            await orchRef.current?.stop();
            setRunning(false);
            setLastEvent('stopped');
            return;
        }
        if (!token) { setLastEvent('no Deriv token'); return; }
        if (!Number.isFinite(parsedStake)) { setLastEvent('stake must be ≥ 0.35'); return; }

        const orch = new Orchestrator(token, { symbols, appId, baseStake: parsedStake });
        orch.setBalance(accountBalance);
        const listener = (ev: OrchestratorEvent) => {
            setLogs(l => [...l.slice(-49), ev]);
            setLastEvent(`${ev.type}${ev.symbol ? ' • ' + ev.symbol : ''}: ${ev.message}`);
            setStats({ ...orch.stats });
            setExecSnap(orch.executionSnapshot);
            setRecoverySnap(orch.recovery.snapshot());
            if (ev.type === 'exit' && typeof ev.pnl === 'number') {
                popupRef.current?.push(ev.pnl, ev.symbol);
            }
            if (ev.type === 'xml' && ev.data?.xml && ev.symbol) {
                setLastXML({ symbol: ev.symbol, xml: ev.data.xml });
            }
        };
        orch.listeners.add(listener);
        orchRef.current = orch;
        setStakeLocked(true);
        try {
            await orch.start();
            setRunning(true);
        } catch (e: any) {
            setLastEvent(`start failed: ${e?.message ?? e}`);
            orch.listeners.delete(listener);
            orchRef.current = null;
            setStakeLocked(false);
        }
    };

    return (
        <>
            <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>

                    <label style={styles.stakeWrap}
                           title={stakeLocked
                            ? 'Base stake locked for this session — stop AI to change'
                            : 'Set your initial stake in USD'}>
                        <span style={{ fontSize: 11, fontWeight: 800,
                                       letterSpacing: '0.10em', textTransform: 'uppercase',
                                       color: '#b8acd8' }}>base $</span>
                        <input type="number" step="0.5" min="0.35" max="100"
                               value={stakeStr}
                               disabled={stakeLocked || running}
                               onChange={e => setStakeStr(e.target.value)}
                               style={styles.stakeInput(stakeLocked)} />
                    </label>

                    <button style={styles.btn(running, !canStart && !running)}
                            disabled={!canStart && !running}
                            onClick={toggle}
                            title={running ? 'Stop AI' : 'Start AI'}>
                        {running ? '⏹  AI Running' : '🤖  AI Assist'}
                    </button>

                    <span style={styles.pill(modeColor(execSnap.mode))}>
                        {execSnap.mode === 'VIRTUAL' ? '👻 VIRTUAL'
                         : execSnap.mode === 'LIVE_MARTINGALE'
                            ? `⚡ MART L${execSnap.martingaleLevel + 1}`
                            : '⚡ LIVE'}
                    </span>
                    <span style={styles.pill(riskColor(execSnap.riskState))}>
                        {execSnap.riskState}
                    </span>
                    {recoverySnap.active && (
                        <span style={styles.pill('#fb923c')}>
                            🛡 RECOVERY
                        </span>
                    )}

                    <button onClick={() => setScannerOpen(true)}   style={styles.secondary}>📡 Scanner</button>
                    <button onClick={() => setAnalyticsOpen(true)} style={styles.secondary}>📊 Analytics</button>
                    <button onClick={() => setExpanded(e => !e)}   style={styles.secondary}>
                        {expanded ? 'Hide details' : 'Show details'}
                    </button>

                    {lastXML && (
                        <button
                            onClick={() => downloadXML(lastXML.xml, `tradewithken-${lastXML.symbol}.xml`)}
                            style={{ ...styles.secondary, borderColor: '#43f3ff', color: '#43f3ff' }}>
                            ⬇ XML · {lastXML.symbol}
                        </button>
                    )}

                    <EmergencyControls orch={orchRef.current} running={running} />

                    <span style={{ fontSize: 13, color: '#b8acd8' }}>{lastEvent}</span>
                </div>

                {expanded && (
                    <div style={styles.panel}>
                        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
                            <div><strong style={{ fontSize: 20 }}>${execSnap.baseStake.toFixed(2)}</strong>
                                 <div style={{ fontSize: 11, opacity:.7 }}>base stake</div></div>
                            <div><strong style={{ fontSize: 20, color: '#43f3ff' }}>${execSnap.nextStake.toFixed(2)}</strong>
                                 <div style={{ fontSize: 11, opacity:.7 }}>next stake</div></div>
                            <div><strong style={{ fontSize: 20 }}>{stats.trades}</strong>
                                 <div style={{ fontSize: 11, opacity:.7 }}>real trades</div></div>
                            <div><strong style={{ fontSize: 20 }}>{stats.virtualTrades}</strong>
                                 <div style={{ fontSize: 11, opacity:.7 }}>virtual</div></div>
                            <div><strong style={{ fontSize: 20, color: '#7dff73' }}>{stats.wins}</strong>
                                 <div style={{ fontSize: 11, opacity:.7 }}>wins</div></div>
                            <div><strong style={{ fontSize: 20, color: '#ff5a7a' }}>{stats.losses}</strong>
                                 <div style={{ fontSize: 11, opacity:.7 }}>losses</div></div>
                            <div><strong style={{ fontSize: 20 }}>${stats.pnl.toFixed(2)}</strong>
                                 <div style={{ fontSize: 11, opacity:.7 }}>real P/L</div></div>
                            <div><strong style={{ fontSize: 20 }}>{(execSnap.virtualWinRate * 100).toFixed(0)}%</strong>
                                 <div style={{ fontSize: 11, opacity:.7 }}>vWR (n={execSnap.sample})</div></div>
                            <div><strong style={{ fontSize: 20 }}>L{execSnap.martingaleLevel}</strong>
                                 <div style={{ fontSize: 11, opacity:.7 }}>mart level</div></div>
                        </div>

                        <div style={{ marginTop: 12, fontSize: 12, color: '#b8acd8', lineHeight: 1.6 }}>
                            <div>Gates: VIRTUAL &lt; 75 %  ·  LIVE 75–94 %  ·  MART ≥ 95 % + validation ≥ 90</div>
                            <div>Martingale: 1× → 3× → 9× · reset on win / cycle / max</div>
                            <div>Fallback to VIRTUAL: vWR &lt; 70 % · 2 consec losses · daily DD · unstable</div>
                            {recoverySnap.active && (
                                <div style={{ color: '#fb923c' }}>Recovery: {recoverySnap.reason}</div>
                            )}
                        </div>

                        <div style={styles.log}>
                            {logs.length === 0 && <div style={{ opacity: .5 }}>no events yet…</div>}
                            {logs.map((e, i) => (
                                <div key={i} style={{
                                    color: e.type === 'error'      ? '#ff5a7a'
                                         : e.type === 'entry'      ? (String(e.message).startsWith('VIRTUAL') ? '#facc15' : '#7dff73')
                                         : e.type === 'exit'       ? (typeof e.pnl === 'number' && e.pnl >= 0 ? '#7dff73' : '#ff5a7a')
                                         : e.type === 'signal'     ? '#43f3ff'
                                         : e.type === 'mode'       ? '#a855f7'
                                         : e.type === 'xml'        ? '#43f3ff'
                                         : e.type === 'recovery'   ? '#fb923c'
                                         : e.type === 'emergency'  ? '#ef4444'
                                                                   : '#dafdff' }}>
                                    [{new Date(e.ts).toLocaleTimeString()}] {e.type}
                                    {e.symbol ? ` (${e.symbol})` : ''}: {e.message}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            <ProfitPopup ref={popupRef} />
            <MarketScanner
                orchestrator={orchRef.current}
                open={scannerOpen}
                onClose={() => setScannerOpen(false)}
                symbols={symbols}
            />
            <AnalyticsDashboard
                journal={orchRef.current?.journal ?? null}
                open={analyticsOpen}
                onClose={() => setAnalyticsOpen(false)}
            />
        </>
    );
};

export default AIToggleButton;

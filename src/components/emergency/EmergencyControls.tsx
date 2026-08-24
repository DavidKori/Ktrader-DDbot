/**
 * Emergency Controls — dropdown menu.
 * -----------------------------------
 * One button, five actions:
 *   ⏹  STOP ALL                 (kill switch — stops engine + closes all)
 *   ❌ Close all trades
 *   💰 Close all profitable
 *   🚫 Disable AI (no new entries)
 *   ⚡ Forex burst — open ≤5 parallel forex at 95 %+ confidence
 *
 * The dropdown closes on outside click and on action select.
 */
import React, { useState, useRef, useEffect } from 'react';
import type { Orchestrator } from '../../ai/lifecycle/orchestrator';

interface Props { orch: Orchestrator | null; running: boolean; }

const styles = {
    btn: {
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '8px 14px', borderRadius: 999,
        border: '1px solid rgba(239,68,68,0.55)',
        background: 'rgba(239,68,68,0.10)', color: '#fca5a5',
        cursor: 'pointer', fontWeight: 700, fontSize: 13,
    } as React.CSSProperties,
    menu: {
        position: 'absolute', right: 0, top: 'calc(100% + 8px)', zIndex: 1000,
        minWidth: 260, padding: 6, borderRadius: 12,
        background: 'rgba(18,13,34,0.96)',
        border: '1px solid rgba(255,255,255,0.10)',
        backdropFilter: 'blur(14px)',
        boxShadow: '0 20px 50px rgba(0,0,0,0.50)',
    } as React.CSSProperties,
    item: {
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px', borderRadius: 8,
        color: '#f4f0ff', fontSize: 13, fontWeight: 600,
        cursor: 'pointer',
        background: 'transparent',
        border: 'none', textAlign: 'left' as const,
        width: '100%',
    } as React.CSSProperties,
};

export const EmergencyControls: React.FC<Props> = ({ orch, running }) => {
    const [open, setOpen] = useState(false);
    const [aiDisabled, setAiDisabled] = useState(false);
    const wrap = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const close = (e: MouseEvent) => {
            if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
        };
        window.addEventListener('click', close);
        return () => window.removeEventListener('click', close);
    }, []);

    const fire = (fn: () => void | Promise<any>) => async () => {
        setOpen(false);
        try { await fn(); } catch { /* swallow — orchestrator emits errors */ }
    };

    const disabled = !orch || !running;
    const itemStyle = (color = '#f4f0ff'): React.CSSProperties => ({
        ...styles.item, color,
    });
    const hover = (e: React.MouseEvent<HTMLButtonElement>, on: boolean) =>
        (e.currentTarget.style.background = on ? 'rgba(255,255,255,0.05)' : 'transparent');

    return (
        <div ref={wrap} style={{ position: 'relative' }}>
            <button
                style={{ ...styles.btn, opacity: disabled ? 0.45 : 1,
                         cursor: disabled ? 'not-allowed' : 'pointer' }}
                disabled={disabled}
                onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}>
                🚨 Emergency ▾
            </button>

            {open && (
                <div style={styles.menu} onClick={e => e.stopPropagation()}>
                    <button style={itemStyle('#ef4444')}
                            onClick={fire(() => orch?.emergencyStopAll())}
                            onMouseEnter={e => hover(e, true)} onMouseLeave={e => hover(e, false)}>
                        ⏹  STOP ALL
                    </button>
                    <button style={itemStyle('#fb923c')}
                            onClick={fire(() => orch?.emergencyCloseAll())}
                            onMouseEnter={e => hover(e, true)} onMouseLeave={e => hover(e, false)}>
                        ❌  Close all trades
                    </button>
                    <button style={itemStyle('#7dff73')}
                            onClick={fire(() => orch?.emergencyCloseProfitable())}
                            onMouseEnter={e => hover(e, true)} onMouseLeave={e => hover(e, false)}>
                        💰  Close all profitable
                    </button>
                    <button style={itemStyle('#facc15')}
                            onClick={fire(() => {
                                if (!orch) return;
                                orch.emergencyDisableAI(!aiDisabled);
                                setAiDisabled(!aiDisabled);
                            })}
                            onMouseEnter={e => hover(e, true)} onMouseLeave={e => hover(e, false)}>
                        {aiDisabled ? '✅  Re-enable AI' : '🚫  Disable AI (no new entries)'}
                    </button>
                    <button style={itemStyle('#a855f7')}
                            onClick={fire(() => orch?.fireForexBurst(0.95))}
                            onMouseEnter={e => hover(e, true)} onMouseLeave={e => hover(e, false)}>
                        ⚡  Forex burst (≤5 at 95%+)
                    </button>
                </div>
            )}
        </div>
    );
};

export default EmergencyControls;

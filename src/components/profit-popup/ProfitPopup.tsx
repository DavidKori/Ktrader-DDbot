/**
 * ProfitPopup — bubbling +profit message after every closed trade.
 * -----------------------------------------------------------------
 *
 *   • Sits in a fixed-position layer (bottom-right by default).
 *   • Subscribes to the orchestrator's `exit` events.
 *   • For each closed trade, pushes a bubble with the realised P/L:
 *       profit  → green   "+4.20"
 *       loss    → red     "-1.10"
 *       breakeven (≈0) → muted yellow "0.00"
 *   • Each bubble lives ~5 s, fades + drifts upward, then auto-removes.
 *
 * Usage:
 *   const popupHandle = useRef<ProfitPopupHandle>(null);
 *   <ProfitPopup ref={popupHandle} />
 *   orch.listeners.add(ev => { if (ev.type === 'exit') popupHandle.current?.push(ev.pnl ?? 0, ev.symbol); });
 */
import React, {
    forwardRef, useImperativeHandle, useState, useEffect, useRef,
} from 'react';

export interface ProfitPopupHandle {
    push(pnl: number, symbol?: string): void;
}

interface Bubble {
    id: number;
    pnl: number;
    symbol?: string;
    spawnedAt: number;
}

const LIFETIME_MS = 5000;

const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '' : '');
const fmt  = (n: number) => `${sign(n)}${n.toFixed(2)}`;

const colourOf = (n: number) =>
    n > 0.005  ? '#22c55e' :        // green for profit
    n < -0.005 ? '#ef4444' :        // red for loss
                 '#facc15';         // amber for ≈0

const glowOf = (n: number) =>
    n > 0.005
        ? '0 0 20px rgba(34,197,94,0.55), 0 10px 28px rgba(34,197,94,0.25)'
        : n < -0.005
        ? '0 0 20px rgba(239,68,68,0.55), 0 10px 28px rgba(239,68,68,0.25)'
        : '0 0 16px rgba(250,204,21,0.45)';

const KEYFRAMES = `
@keyframes twk-bubble-rise {
    0%   { opacity: 0;   transform: translateY(20px) scale(0.85); }
    10%  { opacity: 1;   transform: translateY(0)    scale(1.06); }
    20%  { transform:     translateY(-4px) scale(1.00); }
    80%  { opacity: 1;   transform: translateY(-44px) scale(1.00); }
    100% { opacity: 0;   transform: translateY(-90px) scale(0.92); }
}
@keyframes twk-bubble-pulse {
    0%,100% { box-shadow: 0 0 10px rgba(255,255,255,0.10); }
    50%     { box-shadow: 0 0 22px rgba(255,255,255,0.30); }
}`;

export const ProfitPopup = forwardRef<ProfitPopupHandle>((_, ref) => {
    const [bubbles, setBubbles] = useState<Bubble[]>([]);
    const idRef = useRef(1);

    useEffect(() => {
        if (!document.getElementById('twk-bubble-kf')) {
            const s = document.createElement('style');
            s.id = 'twk-bubble-kf';
            s.textContent = KEYFRAMES;
            document.head.appendChild(s);
        }
    }, []);

    useImperativeHandle(ref, () => ({
        push(pnl, symbol) {
            const id = idRef.current++;
            const b: Bubble = { id, pnl, symbol, spawnedAt: Date.now() };
            setBubbles(prev => [...prev, b]);
            // Auto-remove after the animation completes
            window.setTimeout(() => {
                setBubbles(prev => prev.filter(x => x.id !== id));
            }, LIFETIME_MS);
        },
    }));

    return (
        <div
            aria-live="polite"
            style={{
                position: 'fixed', right: 24, bottom: 28, zIndex: 9999,
                pointerEvents: 'none',
                display: 'flex', flexDirection: 'column-reverse',
                alignItems: 'flex-end', gap: 10,
            }}
        >
            {bubbles.map(b => (
                <div
                    key={b.id}
                    style={{
                        animation: `twk-bubble-rise ${LIFETIME_MS}ms ease-out forwards,
                                    twk-bubble-pulse 1.6s ease-in-out infinite`,
                        padding: '14px 22px',
                        minWidth: 110,
                        borderRadius: 999,
                        background: 'rgba(8, 5, 16, 0.85)',
                        border: `1.5px solid ${colourOf(b.pnl)}`,
                        boxShadow: glowOf(b.pnl),
                        backdropFilter: 'blur(10px)',
                        color: colourOf(b.pnl),
                        fontFamily: 'Orbitron, ui-monospace, monospace',
                        fontWeight: 800,
                        fontSize: 22,
                        letterSpacing: '0.06em',
                        textAlign: 'center',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        lineHeight: 1.1,
                    }}
                    title={b.symbol ? `${b.symbol} ${fmt(b.pnl)}` : fmt(b.pnl)}
                >
                    <span>{fmt(b.pnl)}</span>
                    {b.symbol && (
                        <span style={{ fontSize: 10, opacity: 0.7, marginTop: 4,
                                       letterSpacing: '0.14em',
                                       color: 'rgba(244,240,255,0.85)' }}>
                            {b.symbol}
                        </span>
                    )}
                </div>
            ))}
        </div>
    );
});

ProfitPopup.displayName = 'ProfitPopup';
export default ProfitPopup;

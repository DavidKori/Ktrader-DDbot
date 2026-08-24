/**
 * ManualAutoToggle — v5.5.3
 * =========================
 * Per-instrument card exposing:
 *   - product-family badge (BINARY vs FOREX / multipliers)
 *   - mode toggle: MANUAL ⇄ AI AUTO
 *   - live status chip (idle / scanning / qualified / blocked / executing / managing / completed)
 *   - product-family-specific action surface:
 *       Binary : CALL / PUT (+ optional digit) with duration ticks + stake
 *       Forex  : BUY / SELL (MULTUP/MULTDOWN) with multiplier + stake + optional SL/TP
 *
 * Binary and Forex buttons are DELIBERATELY distinct — different labels,
 * different inputs, different execution paths (see manual-order-router.ts).
 *
 * Manual clicks route through window.__TWK_MANUAL__ which is installed by
 * engine-boot.ts. AUTO mode publishes an `auto_enable` / `auto_disable`
 * event on the bus that the orchestrator picks up on the next scan tick.
 */
import React from 'react';

export type ProductFamily = 'binary' | 'forex';
export type TradeMode     = 'MANUAL' | 'AUTO';
export type InstrumentStatus =
    | 'idle' | 'scanning' | 'qualified' | 'blocked'
    | 'executing' | 'managing' | 'completed';

export interface InstrumentDescriptor {
    symbol: string;
    display: string;
    family: ProductFamily;
    /** Optional: shown as a subtitle (e.g. "Volatility 100 Index"). */
    subtitle?: string;
}

export interface ManualAutoToggleProps {
    instrument: InstrumentDescriptor;
    status: InstrumentStatus;
    /** Persisted per-symbol values (loaded from localStorage by the parent). */
    stake: number;
    /** Binary-only. Ignored for forex. */
    durationTicks?: number;
    /** Forex-only. Ignored for binary. */
    multiplier?: number;
    stopLossPips?: number;
    takeProfitPips?: number;
    /** Current mode; parent owns the state. */
    mode: TradeMode;
    /** True when a Deriv auth token is present. Gates all execute buttons. */
    isAuthed: boolean;
    onModeChange: (m: TradeMode) => void;
    onStakeChange: (n: number) => void;
    onDurationChange?: (n: number) => void;
    onMultiplierChange?: (n: number) => void;
    onSlPipsChange?: (n: number) => void;
    onTpPipsChange?: (n: number) => void;
    /** Manual-only. Parent forwards to window.__TWK_MANUAL__ */
    onManualBinary?: (action: 'CALL' | 'PUT') => void;
    onManualForex?:  (action: 'BUY'  | 'SELL') => void;
}

const cardStyle: React.CSSProperties = {
    border: '1px solid rgba(255,255,255,.08)',
    background: 'rgba(255,255,255,.03)',
    borderRadius: 10,
    padding: '10px 12px',
    marginBottom: 8,
    display: 'flex', flexDirection: 'column', gap: 8,
};

const headerRow: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
};

const symTitle: React.CSSProperties = { fontWeight: 700, fontSize: 13, color: '#fff' };
const subTitle: React.CSSProperties = { fontSize: 11, opacity: 0.6 };

function familyBadge(family: ProductFamily): React.CSSProperties {
    return {
        fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
        padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase',
        background: family === 'binary' ? 'rgba(255,196,0,.15)' : 'rgba(0,200,255,.15)',
        color:      family === 'binary' ? '#ffd76a'             : '#7ee0ff',
        border: `1px solid ${family === 'binary' ? 'rgba(255,196,0,.35)' : 'rgba(0,200,255,.35)'}`,
    };
}

function statusChipStyle(s: InstrumentStatus): React.CSSProperties {
    const colors: Record<InstrumentStatus, { bg: string; fg: string; bd: string }> = {
        idle:      { bg: 'rgba(255,255,255,.06)', fg: '#c8c8c8', bd: 'rgba(255,255,255,.12)' },
        scanning:  { bg: 'rgba(0,180,255,.12)',   fg: '#7ee0ff', bd: 'rgba(0,180,255,.35)'   },
        qualified: { bg: 'rgba(0,220,120,.12)',   fg: '#7cf0b1', bd: 'rgba(0,220,120,.35)'   },
        blocked:   { bg: 'rgba(255,60,60,.14)',   fg: '#ff9a9a', bd: 'rgba(255,60,60,.4)'    },
        executing: { bg: 'rgba(255,166,0,.16)',   fg: '#ffcc7a', bd: 'rgba(255,166,0,.4)'    },
        managing:  { bg: 'rgba(200,120,255,.14)', fg: '#dcb5ff', bd: 'rgba(200,120,255,.4)'  },
        completed: { bg: 'rgba(120,200,120,.14)', fg: '#b7e6b7', bd: 'rgba(120,200,120,.4)'  },
    };
    const c = colors[s];
    return {
        fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
        padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase',
        background: c.bg, color: c.fg, border: `1px solid ${c.bd}`,
    };
}

const modeBtn = (active: boolean, disabled = false): React.CSSProperties => ({
    flex: 1,
    padding: '6px 8px', borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer',
    border: '1px solid ' + (active ? 'rgba(255,46,99,.55)' : 'rgba(255,255,255,.14)'),
    background: active
        ? 'linear-gradient(135deg, #ff6a00 0%, #ff2e63 100%)'
        : 'rgba(255,255,255,.05)',
    color: active ? '#fff' : '#e6e9ef',
    fontWeight: 700, fontSize: 12, opacity: disabled ? 0.5 : 1,
});

const actionBtn = (variant: 'up' | 'down' | 'buy' | 'sell', disabled: boolean): React.CSSProperties => {
    const isBull = variant === 'up' || variant === 'buy';
    return {
        flex: 1,
        padding: '8px 10px', borderRadius: 6,
        border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        background: disabled
            ? 'rgba(255,255,255,.06)'
            : (isBull
                ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                : 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)'),
        color: disabled ? '#888' : '#fff',
        fontWeight: 800, fontSize: 12, letterSpacing: 0.4,
    };
};

const numInput: React.CSSProperties = {
    background: 'rgba(255,255,255,.06)', color: '#fff',
    border: '1px solid rgba(255,255,255,.14)',
    borderRadius: 5, padding: '3px 6px', width: 72, textAlign: 'right',
    fontSize: 12, fontFamily: 'inherit',
};

const labelStyle: React.CSSProperties = { fontSize: 11, opacity: 0.7 };

export const ManualAutoToggle: React.FC<ManualAutoToggleProps> = props => {
    const {
        instrument, status, stake, durationTicks, multiplier,
        stopLossPips, takeProfitPips, mode, isAuthed,
        onModeChange, onStakeChange, onDurationChange, onMultiplierChange,
        onSlPipsChange, onTpPipsChange, onManualBinary, onManualForex,
    } = props;

    const manualDisabled = mode !== 'MANUAL' || !isAuthed || status === 'executing';
    const authTip = !isAuthed ? 'login required to execute manual trades' : '';

    return (
        <div style={cardStyle} data-symbol={instrument.symbol}>
            {/* Header: symbol + family + status */}
            <div style={headerRow}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={symTitle}>{instrument.display}</span>
                    {instrument.subtitle && <span style={subTitle}>{instrument.subtitle}</span>}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                    <span style={familyBadge(instrument.family)}>
                        {instrument.family === 'binary' ? 'Binary' : 'Forex ×'}
                    </span>
                    <span style={statusChipStyle(status)}>{status}</span>
                </div>
            </div>

            {/* Mode toggle */}
            <div style={{ display: 'flex', gap: 6 }}>
                <button
                    style={modeBtn(mode === 'MANUAL')}
                    onClick={() => onModeChange('MANUAL')}
                >Manual</button>
                <button
                    style={modeBtn(mode === 'AUTO')}
                    onClick={() => onModeChange('AUTO')}
                >AI Auto</button>
            </div>

            {/* Product-family-specific controls */}
            {instrument.family === 'binary' ? (
                <>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span style={labelStyle}>Stake $</span>
                        <input
                            type='number' min={0.35} max={100} step={0.01}
                            value={stake}
                            onChange={e => onStakeChange(Number(e.target.value))}
                            style={numInput}
                        />
                        <span style={labelStyle}>Ticks</span>
                        <input
                            type='number' min={1} max={15} step={1}
                            value={durationTicks ?? 5}
                            onChange={e => onDurationChange?.(Number(e.target.value))}
                            style={{ ...numInput, width: 56 }}
                        />
                    </div>
                    <div style={{ display: 'flex', gap: 6 }} title={authTip}>
                        <button
                            style={actionBtn('up', manualDisabled)}
                            disabled={manualDisabled}
                            onClick={() => onManualBinary?.('CALL')}
                        >CALL ▲</button>
                        <button
                            style={actionBtn('down', manualDisabled)}
                            disabled={manualDisabled}
                            onClick={() => onManualBinary?.('PUT')}
                        >PUT ▼</button>
                    </div>
                </>
            ) : (
                <>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={labelStyle}>Stake $</span>
                        <input
                            type='number' min={0.35} max={2000} step={0.01}
                            value={stake}
                            onChange={e => onStakeChange(Number(e.target.value))}
                            style={numInput}
                        />
                        <span style={labelStyle}>×</span>
                        <input
                            type='number' min={1} max={1000} step={1}
                            value={multiplier ?? 100}
                            onChange={e => onMultiplierChange?.(Number(e.target.value))}
                            style={{ ...numInput, width: 60 }}
                        />
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={labelStyle}>SL (p)</span>
                        <input
                            type='number' min={0} max={500} step={1}
                            value={stopLossPips ?? 0}
                            onChange={e => onSlPipsChange?.(Number(e.target.value))}
                            style={{ ...numInput, width: 56 }}
                        />
                        <span style={labelStyle}>TP (p)</span>
                        <input
                            type='number' min={0} max={500} step={1}
                            value={takeProfitPips ?? 0}
                            onChange={e => onTpPipsChange?.(Number(e.target.value))}
                            style={{ ...numInput, width: 56 }}
                        />
                    </div>
                    <div style={{ display: 'flex', gap: 6 }} title={authTip}>
                        <button
                            style={actionBtn('buy', manualDisabled)}
                            disabled={manualDisabled}
                            onClick={() => onManualForex?.('BUY')}
                        >BUY ▲</button>
                        <button
                            style={actionBtn('sell', manualDisabled)}
                            disabled={manualDisabled}
                            onClick={() => onManualForex?.('SELL')}
                        >SELL ▼</button>
                    </div>
                </>
            )}

            {!isAuthed && mode === 'MANUAL' && (
                <div style={{ fontSize: 10, opacity: 0.7, color: '#ff9a9a' }}>
                    login required to execute manual trades — scanning still active
                </div>
            )}
        </div>
    );
};

export default ManualAutoToggle;

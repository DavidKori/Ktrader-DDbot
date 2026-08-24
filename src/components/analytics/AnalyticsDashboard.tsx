/**
 * Analytics Dashboard
 * -------------------
 * Live performance panel powered by the TradeJournal.
 *
 * Shows for ALL · LIVE · LIVE_MARTINGALE · VIRTUAL:
 *   • Trade count · Wins / Losses · WinRate · ProfitFactor
 *   • NetPnL · AvgWin · AvgLoss · Max DD ($/%) · Longest streaks
 *   • Per-symbol breakdown
 *   • CSV / JSON export buttons
 */
import React, { useState, useEffect, useMemo } from 'react';
import type { TradeJournal, JournalEntry } from '../../ai/journal/trade-journal';
import {
    computePerformance, performanceBySymbol, PerformanceMetrics,
} from '../../ai/analytics/performance';

interface Props { journal: TradeJournal | null; open: boolean; onClose: () => void; }

const palette = {
    bg:     'rgba(8,5,16,0.96)',
    panel:  'rgba(18,13,34,0.92)',
    line:   'rgba(255,255,255,0.10)',
    text:   '#f4f0ff', muted:  '#b8acd8',
    purple: '#a855f7', green: '#22c55e', cyan: '#43f3ff',
    red:    '#ef4444', amber: '#facc15',
};

const Stat: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color }) => (
    <div style={{ display:'flex', flexDirection:'column', minWidth: 120 }}>
        <strong style={{ fontSize: 20, color: color ?? palette.text }}>{value}</strong>
        <span style={{ fontSize: 11, color: palette.muted, textTransform:'uppercase',
                       letterSpacing:'0.08em', marginTop: 2 }}>{label}</span>
    </div>
);

const MetricCard: React.FC<{ title: string; m: PerformanceMetrics }> = ({ title, m }) => {
    const pf = m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2);
    const winColor = m.winRate >= 0.55 ? palette.green : m.winRate >= 0.45 ? palette.amber : palette.red;
    return (
        <div style={{
            padding: '14px 16px', borderRadius: 12,
            background: 'rgba(255,255,255,0.03)',
            border: `1px solid ${palette.line}`,
        }}>
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.10em',
                          textTransform: 'uppercase', color: palette.muted, marginBottom: 10 }}>
                {title}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                <Stat label="Trades"   value={String(m.closedTrades)} />
                <Stat label="WinRate"  value={`${(m.winRate * 100).toFixed(1)}%`} color={winColor} />
                <Stat label="PF"       value={pf} color={m.profitFactor >= 1.5 ? palette.green : palette.amber} />
                <Stat label="Net P/L"  value={`$${m.netPnL.toFixed(2)}`}
                      color={m.netPnL > 0 ? palette.green : m.netPnL < 0 ? palette.red : palette.text}/>
                <Stat label="Avg Win"  value={`$${m.avgWin.toFixed(2)}`}  color={palette.green} />
                <Stat label="Avg Loss" value={`$${m.avgLoss.toFixed(2)}`} color={palette.red}   />
                <Stat label="Max DD"   value={`$${m.maxDrawdown.toFixed(2)} (${(m.maxDrawdownPct*100).toFixed(1)}%)`}
                      color={palette.amber} />
                <Stat label="W-Streak" value={String(m.longestWinStreak)}  color={palette.green} />
                <Stat label="L-Streak" value={String(m.longestLossStreak)} color={palette.red}   />
                <Stat label="Avg Hold" value={`${Math.round(m.avgDurationSec)}s`} />
            </div>
        </div>
    );
};

export const AnalyticsDashboard: React.FC<Props> = ({ journal, open, onClose }) => {
    const [entries, setEntries] = useState<JournalEntry[]>([]);

    useEffect(() => {
        if (!journal) return;
        setEntries(journal.all());
        const fn = (es: JournalEntry[]) => setEntries(es);
        journal.listeners.add(fn);
        return () => { journal.listeners.delete(fn); };
    }, [journal]);

    const all      = useMemo(() => computePerformance(entries),                          [entries]);
    const live     = useMemo(() => computePerformance(entries, { mode: 'LIVE' }),        [entries]);
    const mart     = useMemo(() => computePerformance(entries, { mode: 'LIVE_MARTINGALE' }), [entries]);
    const virtual  = useMemo(() => computePerformance(entries, { mode: 'VIRTUAL' }),     [entries]);
    const bySym    = useMemo(() => performanceBySymbol(entries),                         [entries]);

    if (!open) return null;

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 10_000,
            background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
            display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
            padding: '40px 20px', overflowY: 'auto',
        }}>
            <div style={{
                width: 'min(960px, 100%)', background: palette.bg,
                border: `1px solid ${palette.line}`,
                borderRadius: 18, color: palette.text,
                boxShadow: '0 30px 80px rgba(0,0,0,0.55)', overflow: 'hidden',
            }}>
                <div style={{ padding: '18px 22px',
                              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              background: 'linear-gradient(90deg, rgba(124,58,237,0.20), transparent)' }}>
                    <h2 style={{ margin: 0, fontFamily: 'Orbitron, sans-serif',
                                 fontSize: 22, letterSpacing: '0.04em' }}>
                        Performance Analytics
                    </h2>
                    <button onClick={onClose} aria-label="close"
                            style={{ background: 'transparent', border: 'none',
                                     color: palette.muted, fontSize: 22, cursor: 'pointer' }}>×</button>
                </div>

                <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {entries.length === 0 && (
                        <div style={{ padding: 16, color: palette.muted, fontSize: 14 }}>
                            No trades yet — start the AI engine and the journal will populate.
                        </div>
                    )}

                    {entries.length > 0 && (
                        <>
                            <MetricCard title="All trades"        m={all}     />
                            <MetricCard title="LIVE"              m={live}    />
                            <MetricCard title="LIVE_MARTINGALE"   m={mart}    />
                            <MetricCard title="VIRTUAL (shadow)"  m={virtual} />

                            <div style={{ marginTop: 6 }}>
                                <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.10em',
                                              textTransform: 'uppercase', color: palette.muted, marginBottom: 8 }}>
                                    Per symbol
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    {Object.entries(bySym).map(([sym, m]) => {
                                        const wc = m.winRate >= 0.55 ? palette.green
                                                 : m.winRate >= 0.45 ? palette.amber : palette.red;
                                        return (
                                            <div key={sym} style={{ display: 'flex', justifyContent: 'space-between',
                                                                     padding: '8px 12px', borderRadius: 8,
                                                                     background: 'rgba(255,255,255,0.03)',
                                                                     border: `1px solid ${palette.line}`,
                                                                     fontSize: 13 }}>
                                                <span style={{ fontWeight: 700 }}>{sym}</span>
                                                <span style={{ color: palette.muted }}>n={m.closedTrades}</span>
                                                <span style={{ color: wc, fontWeight: 700 }}>
                                                    {(m.winRate*100).toFixed(0)}% WR
                                                </span>
                                                <span style={{ color: m.netPnL >= 0 ? palette.green : palette.red,
                                                                fontWeight: 700 }}>
                                                    ${m.netPnL.toFixed(2)}
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </>
                    )}

                    <div style={{ display:'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
                        <button onClick={() => journal?.downloadCSV()}
                                style={{ padding: '10px 16px', borderRadius: 10,
                                         border: `1px solid ${palette.cyan}`, color: palette.cyan,
                                         background: 'transparent', cursor: 'pointer', fontWeight: 700 }}>
                            ⬇ CSV
                        </button>
                        <button onClick={() => journal?.downloadJSON()}
                                style={{ padding: '10px 16px', borderRadius: 10,
                                         border: `1px solid ${palette.purple}`, color: palette.purple,
                                         background: 'transparent', cursor: 'pointer', fontWeight: 700 }}>
                            ⬇ JSON
                        </button>
                        <button onClick={() => { if (confirm('Clear all journal entries?')) journal?.clear(); }}
                                style={{ padding: '10px 16px', borderRadius: 10,
                                         border: `1px solid ${palette.red}`, color: palette.red,
                                         background: 'transparent', cursor: 'pointer', fontWeight: 700 }}>
                            🗑 Clear journal
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AnalyticsDashboard;

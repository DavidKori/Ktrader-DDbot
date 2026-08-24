/**
 * MarketScanner — modal UI matching the user's mockup.
 * ----------------------------------------------------
 * Fields:
 *   • Number of ticks to scan (default 500, user-editable)
 *   • Best market (ranked)
 *   • Strategy (auto-picked by regime + digit analysis)
 *   • Entry digit (when applicable)
 *   • Win rate · Sample size · Quality score · Recent win rate
 *   • Per-market quality bars
 *   • "Deep Scan for Best Market" button (runs scanAll)
 *   • "Load Deep Scanner Bot" button (downloads XML + emits to orchestrator log)
 */
import React, { useState, useCallback, useMemo } from 'react';
import {
    scanAll, ScanResult, pickBestMarket,
} from '../../ai/scanner/market-scanner';
import { xmlFromScan, downloadXML } from '../../ai/xml/xml-generator';
import type { Orchestrator } from '../../ai/lifecycle/orchestrator';

interface Props {
    orchestrator: Orchestrator | null;
    open: boolean;
    onClose: () => void;
    /** Symbols to include in the scan. Defaults to the orchestrator's symbols. */
    symbols?: string[];
}

const palette = {
    bg:     'rgba(8,5,16,0.92)',
    panel:  'rgba(18,13,34,0.92)',
    line:   'rgba(255,255,255,0.10)',
    text:   '#f4f0ff',
    muted:  '#b8acd8',
    purple: '#7c3aed',
    green:  '#16a34a',
    cyan:   '#43f3ff',
    lime:   '#7dff73',
    amber:  '#facc15',
};

const QualityBar: React.FC<{ value: number; rank: number }> = ({ value, rank }) => (
    <div style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between',
                      fontSize: 12, color: palette.muted, marginBottom: 4 }}>
            <span>rank {rank}</span>
            <span>{value.toFixed(2)}/100</span>
        </div>
        <div style={{ width: '100%', height: 6, background: 'rgba(255,255,255,0.06)',
                      borderRadius: 4, overflow: 'hidden' }}>
            <div style={{
                width: `${Math.max(2, Math.min(100, value))}%`, height: '100%',
                background: `linear-gradient(90deg, ${palette.purple}, ${palette.cyan})`,
                transition: 'width .4s ease',
            }}/>
        </div>
    </div>
);

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.16em',
                  textTransform: 'uppercase', color: palette.muted, marginBottom: 6 }}>
        {children}
    </div>
);

const Box: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
    <div style={{ padding: '12px 14px', borderRadius: 10,
                  background: 'rgba(255,255,255,0.04)',
                  border: `1px solid ${palette.line}`,
                  color: palette.text, fontWeight: 600, ...style }}>
        {children}
    </div>
);

export const MarketScanner: React.FC<Props> = ({ orchestrator, open, onClose, symbols }) => {
    const [tickCount, setTickCount] = useState<number>(500);
    const [scanning, setScanning] = useState<boolean>(false);
    const [results, setResults] = useState<ScanResult[]>([]);
    const [error, setError]     = useState<string>('');

    const symbolList = useMemo(() =>
        symbols && symbols.length ? symbols : (orchestrator as any)?.cfg?.symbols ?? [],
        [symbols, orchestrator]);

    const best = useMemo(() => pickBestMarket(results), [results]);

    const runScan = useCallback(async () => {
        if (!orchestrator) { setError('Start the AI engine first'); return; }
        if (symbolList.length === 0) { setError('No symbols to scan'); return; }
        setError('');
        setScanning(true);
        try {
            const inputs = await Promise.all(
                symbolList.map(async (s: string) => {
                    try { return await orchestrator.fetchScanInputs(s, tickCount); }
                    catch { return null; }
                })
            );
            const valid = inputs.filter(Boolean) as Array<{
                symbol: string; candles: any[]; ticks: number[]; volumes: number[];
            }>;
            const out = await scanAll(valid);
            setResults(out);
        } catch (e: any) {
            setError(e?.message ?? 'scan failed');
        } finally {
            setScanning(false);
        }
    }, [orchestrator, symbolList, tickCount]);

    const loadBest = useCallback(() => {
        if (!best || !best.contractType) return;
        const xml = xmlFromScan(best, 1, 5);
        if (xml) {
            downloadXML(xml, `tradewithken-${best.symbol}.xml`);
        }
    }, [best]);

    if (!open) return null;

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 10_000,
            background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
            display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
            padding: '40px 20px', overflowY: 'auto',
        }}>
            <div style={{
                width: 'min(640px, 100%)',
                background: palette.bg,
                border: `1px solid ${palette.line}`,
                borderRadius: 18, color: palette.text,
                boxShadow: '0 30px 80px rgba(0,0,0,0.55)',
                overflow: 'hidden',
            }}>
                {/* Header */}
                <div style={{ padding: '18px 22px',
                              display: 'flex', justifyContent: 'space-between',
                              alignItems: 'center',
                              background: 'linear-gradient(90deg, rgba(124,58,237,0.18), transparent)' }}>
                    <h2 style={{ margin: 0, fontFamily: 'Orbitron, sans-serif',
                                 fontSize: 22, letterSpacing: '0.04em' }}>
                        Entry Scanner
                    </h2>
                    <button onClick={onClose} aria-label="close"
                            style={{ background: 'transparent', border: 'none',
                                     color: palette.muted, fontSize: 22, cursor: 'pointer' }}>
                        ×
                    </button>
                </div>

                <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>

                    <Box style={{ fontWeight: 500, lineHeight: 1.45, fontSize: 13 }}>
                        Deep scanner evaluates all enabled markets, then finds the best
                        entry point and strategy profile based on live tick data + the
                        LightGBM probability model.
                    </Box>

                    <div>
                        <SectionLabel>Number of ticks to scan</SectionLabel>
                        <input type="number" min={100} max={2000} step={50}
                               value={tickCount}
                               onChange={e => setTickCount(Math.max(100, Math.min(2000, Number(e.target.value) || 500)))}
                               style={{ width: '100%', padding: '10px 12px', borderRadius: 8,
                                        background: 'rgba(255,255,255,0.06)',
                                        border: `1px solid ${palette.line}`,
                                        color: palette.text, fontSize: 14, fontWeight: 700 }}/>
                    </div>

                    <div>
                        <SectionLabel>Best market</SectionLabel>
                        <Box>{best ? best.displayName : '—'}</Box>
                    </div>

                    <div>
                        <SectionLabel>Strategy</SectionLabel>
                        <Box>{best ? best.strategy : '—'}</Box>
                    </div>

                    {best?.entryDigit !== undefined && (
                        <div>
                            <SectionLabel>Entry digit</SectionLabel>
                            <Box>{best.entryDigit}</Box>
                        </div>
                    )}
                    {best?.barrier !== undefined && (
                        <div>
                            <SectionLabel>Barrier</SectionLabel>
                            <Box>{best.barrier}</Box>
                        </div>
                    )}

                    {best && (
                        <div style={{
                            padding: '14px 16px', borderRadius: 10,
                            background: 'linear-gradient(180deg, rgba(124,58,237,0.10), rgba(67,243,255,0.08))',
                            border: `1px solid ${palette.line}`,
                        }}>
                            <div style={{ display: 'grid',
                                          gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 13 }}>
                                <div>Win Rate: <strong>{(best.winRate * 100).toFixed(1)}%</strong></div>
                                <div>Sample Size: <strong>{best.sampleSize}</strong></div>
                                <div>Quality Score: <strong style={{ color: palette.lime }}>{best.qualityScore.toFixed(2)}%</strong></div>
                                <div>Recent Win Rate: <strong>{(best.recentWinRate * 100).toFixed(1)}%</strong></div>
                            </div>
                        </div>
                    )}

                    {results.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {results.map(r => (
                                <div key={r.symbol}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between',
                                                  fontSize: 13, marginBottom: 4 }}>
                                        <span style={{ color: palette.muted }}>{r.displayName}</span>
                                        <span style={{ fontWeight: 700,
                                                       color: r.qualityScore > 70 ? palette.lime
                                                            : r.qualityScore > 50 ? palette.cyan
                                                                                  : palette.amber }}>
                                            {r.qualityScore.toFixed(1)} / 100
                                        </span>
                                    </div>
                                    <QualityBar value={r.qualityScore} rank={r.rank}/>
                                </div>
                            ))}
                        </div>
                    )}

                    {best && (
                        <div style={{
                            padding: '12px 14px', borderLeft: `3px solid ${palette.lime}`,
                            background: 'rgba(34,197,94,0.06)', borderRadius: 6, fontSize: 13,
                        }}>
                            Best market: <strong>{best.displayName}</strong> ·{' '}
                            <strong>{best.strategy}</strong> · Quality{' '}
                            <strong style={{ color: palette.lime }}>{best.qualityScore.toFixed(2)}%</strong>
                        </div>
                    )}

                    {error && (
                        <div style={{ color: '#ef4444', fontSize: 13 }}>{error}</div>
                    )}

                    <button onClick={runScan} disabled={scanning}
                            style={{ marginTop: 4, padding: '14px 18px',
                                     borderRadius: 10, border: 'none', cursor: scanning ? 'wait' : 'pointer',
                                     background: `linear-gradient(90deg, ${palette.purple}, ${palette.cyan})`,
                                     color: '#fff', fontSize: 15, fontWeight: 800,
                                     letterSpacing: '0.05em', textTransform: 'uppercase',
                                     opacity: scanning ? 0.7 : 1 }}>
                        {scanning ? 'Scanning…' : 'Deep Scan for Best Market'}
                    </button>

                    <button onClick={loadBest} disabled={!best}
                            style={{ padding: '14px 18px', borderRadius: 10,
                                     background: 'transparent',
                                     color: best ? palette.text : palette.muted,
                                     border: `2px solid ${best ? palette.cyan : palette.line}`,
                                     fontSize: 14, fontWeight: 800,
                                     letterSpacing: '0.04em',
                                     cursor: best ? 'pointer' : 'not-allowed' }}>
                        Load Deep Scanner Bot (XML)
                    </button>
                </div>
            </div>
        </div>
    );
};

export default MarketScanner;

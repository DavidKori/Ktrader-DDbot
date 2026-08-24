/**
 * Trade Journal
 * -------------
 * Persistent log of every trade the system opens & closes.
 * Stored in localStorage when available; in-memory otherwise.
 *
 * The journal feeds:
 *   • Performance Analytics (WR / PF / ROI / DD)
 *   • Future LightGBM retraining datasets
 *   • The CSV / JSON export buttons in the UI
 */
export interface JournalEntry {
    id:             string;
    ts_open:        number;
    ts_close?:      number;
    symbol:         string;
    kind:           'forex' | 'binary';
    contractType:   string;
    direction:      'UP' | 'DOWN' | 'NEUTRAL';
    mode:           'VIRTUAL' | 'LIVE' | 'LIVE_MARTINGALE';
    martingaleLevel: number;
    durationTicks?: number;
    durationSec?:   number;
    entryPrice:     number;
    exitPrice?:     number;
    stake:          number;
    pnl?:           number;
    confidence:     number;
    validationScore: number;
    qualityScore?:  number;
    regime:         string;
    exitReason?:    string;
    barrier?:       number;
    targetDigit?:   number;
}

const STORAGE_KEY = 'twk_trade_journal_v1';

const isBrowser = (): boolean =>
    typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const safeLoad = (): JournalEntry[] => {
    if (!isBrowser()) return [];
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr as JournalEntry[] : [];
    } catch { return []; }
};

const safeSave = (entries: JournalEntry[]) => {
    if (!isBrowser()) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-1000))); }
    catch { /* quota / disabled */ }
};

export class TradeJournal {
    private entries: JournalEntry[];
    public listeners = new Set<(entries: JournalEntry[]) => void>();

    constructor() { this.entries = safeLoad(); }

    /** Add an OPEN entry. Returns the generated id. */
    open(e: Omit<JournalEntry, 'id' | 'ts_open'> & { id?: string }): string {
        const id = e.id ?? `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.entries.push({ ...e, id, ts_open: Date.now() });
        this.flush();
        return id;
    }

    /** Append the CLOSE side of a trade by id. */
    close(id: string, patch: Partial<JournalEntry>) {
        const idx = this.entries.findIndex(x => x.id === id);
        if (idx === -1) return;
        this.entries[idx] = {
            ...this.entries[idx], ...patch, ts_close: Date.now(),
        };
        this.flush();
    }

    all(): JournalEntry[] { return this.entries.slice(); }

    /** Last `n` entries. */
    last(n: number): JournalEntry[] { return this.entries.slice(-n); }

    /** Filtered queries. */
    filterByKind(kind: 'forex' | 'binary'): JournalEntry[] {
        return this.entries.filter(e => e.kind === kind);
    }
    filterByMode(mode: JournalEntry['mode']): JournalEntry[] {
        return this.entries.filter(e => e.mode === mode);
    }
    filterByDateRange(fromMs: number, toMs: number): JournalEntry[] {
        return this.entries.filter(e => e.ts_open >= fromMs && e.ts_open <= toMs);
    }

    clear() { this.entries = []; this.flush(); }

    /** CSV export — all closed trades. */
    toCSV(): string {
        const closed = this.entries.filter(e => e.ts_close);
        const header = [
            'id','open','close','symbol','kind','contract','direction','mode','mart_level',
            'duration_ticks','duration_sec','entry','exit','stake','pnl','confidence',
            'validation','quality','regime','exit_reason','barrier','digit',
        ].join(',');
        const rows = closed.map(e => [
            e.id,
            new Date(e.ts_open).toISOString(),
            e.ts_close ? new Date(e.ts_close).toISOString() : '',
            e.symbol, e.kind, e.contractType, e.direction, e.mode, e.martingaleLevel,
            e.durationTicks ?? '', e.durationSec ?? '',
            e.entryPrice, e.exitPrice ?? '', e.stake, e.pnl ?? '',
            e.confidence.toFixed(3), e.validationScore.toFixed(1),
            e.qualityScore?.toFixed(1) ?? '', e.regime,
            e.exitReason ?? '', e.barrier ?? '', e.targetDigit ?? '',
        ].join(','));
        return [header, ...rows].join('\n');
    }

    /** Download helpers (UI). */
    downloadCSV(fileName = 'tradewithken-journal.csv') {
        if (!isBrowser()) return;
        this.downloadBlob(this.toCSV(), 'text/csv', fileName);
    }
    downloadJSON(fileName = 'tradewithken-journal.json') {
        if (!isBrowser()) return;
        this.downloadBlob(JSON.stringify(this.entries, null, 2), 'application/json', fileName);
    }

    private downloadBlob(content: string, mime: string, fileName: string) {
        const blob = new Blob([content], { type: mime });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = fileName;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    private flush() {
        safeSave(this.entries);
        const snapshot = this.entries.slice();
        this.listeners.forEach(l => { try { l(snapshot); } catch {} });
    }
}

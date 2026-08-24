/**
 * Instrument State Store — v5.5.3
 * ===============================
 * Per-symbol persistence for the ManualAutoToggle cards:
 *   - mode (MANUAL | AUTO)
 *   - stake
 *   - durationTicks (binary)
 *   - multiplier / SL / TP (forex)
 * Keys are namespaced under `twkInstr:<symbol>` so they don't collide with
 * the global base-stake key.
 *
 * Also exposes the canonical instrument list + a symbol → status subscriber
 * that reads from window.__TWK_BUS__ events.
 */
import type { InstrumentDescriptor, InstrumentStatus, ProductFamily, TradeMode } from './ManualAutoToggle';

export interface InstrumentPrefs {
    mode: TradeMode;
    stake: number;
    // binary
    durationTicks: number;
    // forex
    multiplier: number;
    stopLossPips: number;
    takeProfitPips: number;
}

const NS = 'twkInstr:';

export const DEFAULT_INSTRUMENTS: InstrumentDescriptor[] = [
    // Forex majors (multipliers)
    { symbol: 'frxEURUSD', display: 'EUR/USD',  family: 'forex',  subtitle: 'Multipliers' },
    { symbol: 'frxGBPUSD', display: 'GBP/USD',  family: 'forex',  subtitle: 'Multipliers' },
    { symbol: 'frxUSDJPY', display: 'USD/JPY',  family: 'forex',  subtitle: 'Multipliers' },
    { symbol: 'frxAUDUSD', display: 'AUD/USD',  family: 'forex',  subtitle: 'Multipliers' },
    // Synthetic / binary
    { symbol: 'R_100',     display: 'Vol 100',      family: 'binary', subtitle: 'Volatility Index' },
    { symbol: 'R_75',      display: 'Vol 75',       family: 'binary', subtitle: 'Volatility Index' },
    { symbol: '1HZ100V',   display: 'Vol 100 (1s)', family: 'binary', subtitle: '1-second Index'   },
];

export function defaultPrefs(family: ProductFamily, baseStake: number): InstrumentPrefs {
    return {
        mode: 'MANUAL',
        stake: baseStake,
        durationTicks: 5,
        multiplier: family === 'forex' ? 100 : 0,
        stopLossPips: 0,
        takeProfitPips: 0,
    };
}

export function loadPrefs(symbol: string, family: ProductFamily, baseStake: number): InstrumentPrefs {
    try {
        const raw = localStorage.getItem(NS + symbol);
        if (raw) {
            const p = JSON.parse(raw);
            return { ...defaultPrefs(family, baseStake), ...p };
        }
    } catch { /* ignore */ }
    return defaultPrefs(family, baseStake);
}

export function savePrefs(symbol: string, prefs: InstrumentPrefs): void {
    try { localStorage.setItem(NS + symbol, JSON.stringify(prefs)); } catch { /* ignore */ }
}

/**
 * Map a raw bus event to an InstrumentStatus. Orchestrator emits:
 *   type=tick               -> scanning
 *   type=signal_qualified   -> qualified
 *   type=risk_blocked       -> blocked
 *   type=trade_open|entry   -> executing
 *   type=trade_manage       -> managing
 *   type=trade_close|exit   -> completed
 */
export function mapEventToStatus(evType: string): InstrumentStatus | null {
    switch (evType) {
        case 'tick':
        case 'scan':                return 'scanning';
        case 'signal_qualified':
        case 'signal':              return 'qualified';
        case 'risk_blocked':
        case 'blocked':             return 'blocked';
        case 'trade_open':
        case 'entry':               return 'executing';
        case 'trade_manage':
        case 'manage':              return 'managing';
        case 'trade_close':
        case 'exit':                return 'completed';
        default:                    return null;
    }
}

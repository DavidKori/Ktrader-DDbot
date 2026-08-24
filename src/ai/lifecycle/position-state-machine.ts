/**
 * Position State Machine — 10 states, identical for forex and binary.
 * Illegal transitions throw — protects against ad-hoc lifecycle bugs.
 */
export type PosState =
    | 'IDLE' | 'ANALYZING' | 'SIGNAL_CONFIRMED' | 'ENTERING_TRADE'
    | 'TRADE_ACTIVE' | 'MANAGING_POSITION' | 'EXIT_CONDITION_MET'
    | 'CLOSING_TRADE' | 'LOGGING_RESULTS' | 'ERROR';

const LEGAL: Record<PosState, PosState[]> = {
    IDLE:                ['ANALYZING', 'ERROR'],
    ANALYZING:           ['SIGNAL_CONFIRMED', 'IDLE', 'ERROR'],
    SIGNAL_CONFIRMED:    ['ENTERING_TRADE', 'IDLE', 'ERROR'],
    ENTERING_TRADE:      ['TRADE_ACTIVE', 'ERROR', 'IDLE'],
    TRADE_ACTIVE:        ['MANAGING_POSITION', 'EXIT_CONDITION_MET', 'ERROR'],
    MANAGING_POSITION:   ['EXIT_CONDITION_MET', 'TRADE_ACTIVE', 'ERROR'],
    EXIT_CONDITION_MET:  ['CLOSING_TRADE', 'ERROR'],
    CLOSING_TRADE:       ['LOGGING_RESULTS', 'ERROR'],
    LOGGING_RESULTS:     ['IDLE'],
    ERROR:               ['IDLE'],
};

export interface PosCtx {
    symbol: string;
    direction: 'UP' | 'DOWN' | 'NEUTRAL';
    contractType: string;
    entryPrice?: number;
    contractId?: string;
    openedAt?: number;
    closedAt?: number;
    pnl?: number;
    note?: string;
}

export class PositionStateMachine {
    private state: PosState = 'IDLE';
    private history: { state: PosState; at: number }[] = [{ state: 'IDLE', at: Date.now() }];
    constructor(public ctx: PosCtx) {}
    current(): PosState { return this.state; }

    transition(next: PosState, mut?: Partial<PosCtx>) {
        if (!LEGAL[this.state].includes(next)) {
            throw new Error(`Illegal transition ${this.state} → ${next}`);
        }
        this.state = next;
        if (mut) Object.assign(this.ctx, mut);
        this.history.push({ state: next, at: Date.now() });
    }

    snapshot() { return { state: this.state, ctx: this.ctx, history: this.history.slice() }; }
}

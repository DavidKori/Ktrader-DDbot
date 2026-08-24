export const REQUESTS = [
    'active_symbols',
    'authorize',
    'balance',
    'buy',
    'proposal',
    'proposal_open_contract',
    'transaction',
    'ticks_history',
    'history',
];

// FIX (audit v5.5.6): the previous architecture ran a stake cap, an open-
// contracts cap, and a daily-loss circuit breaker *server-side*, inside the
// now-removed WS proxy (server-node/index.js). Since that proxy is no
// longer in the live trading path (it called Deriv endpoints that don't
// exist), those safeguards were silently lost. This restores an equivalent
// client-side gate on outgoing `buy` requests, using @deriv/deriv-api's
// `sendWillBeCalled` middleware hook, which runs before a request is sent
// and can short-circuit it. Limits are configurable via localStorage so the
// UI (or a future settings panel) can adjust them without a rebuild.
const DEFAULT_LIMITS = {
    maxStake: 100,
    maxOpenContracts: 2,
    maxDailyLoss: 300,
};

const getLimits = () => {
    try {
        const raw = window.localStorage.getItem('twk_risk_limits');
        if (!raw) return DEFAULT_LIMITS;
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_LIMITS, ...parsed };
    } catch {
        return DEFAULT_LIMITS;
    }
};

const todayKey = () => new Date().toISOString().slice(0, 10);

const getRiskState = () => {
    try {
        const raw = window.localStorage.getItem('twk_risk_state');
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && parsed.day === todayKey()) return parsed;
    } catch {
        /* fall through to fresh state */
    }
    return { day: todayKey(), openContracts: 0, lossToday: 0 };
};

const saveRiskState = state => {
    try {
        window.localStorage.setItem('twk_risk_state', JSON.stringify(state));
    } catch {
        /* best-effort only */
    }
};

// Called from the trade-engine / contract-store when a contract opens or
// settles, so the daily-loss and open-contracts counters stay accurate.
export const recordContractOpened = () => {
    const state = getRiskState();
    state.openContracts += 1;
    saveRiskState(state);
};

export const recordContractClosed = profit => {
    const state = getRiskState();
    state.openContracts = Math.max(0, state.openContracts - 1);
    if (typeof profit === 'number' && profit < 0) {
        state.lossToday += Math.abs(profit);
    }
    saveRiskState(state);
};

class APIMiddleware {
    constructor(config) {
        this.config = config;
        this.debounced_calls = {};
    }

    getRequestType = request => {
        let req_type;
        REQUESTS.forEach(type => {
            if (type in request && !req_type) req_type = type;
        });

        return req_type;
    };

    defineMeasure = res_type => {
        if (res_type) {
            let measure;
            if (res_type === 'history') {
                performance.mark('ticks_history_end');
                measure = performance.measure('ticks_history', 'ticks_history_start', 'ticks_history_end');
            } else {
                performance.mark(`${res_type}_end`);
                measure = performance.measure(`${res_type}`, `${res_type}_start`, `${res_type}_end`);
            }
            return (measure.startTimeDate = new Date(Date.now() - measure.startTime));
        }
        return false;
    };

    // Pre-send hook: reject `buy` requests that would breach the configured
    // risk limits, before they ever reach Deriv.
    sendWillBeCalled = ({ args: [request] }) => {
        if (!request || !('buy' in request)) return undefined;

        const limits = getLimits();
        const state = getRiskState();
        const stake = Number(request.price ?? 0);

        if (state.lossToday >= limits.maxDailyLoss) {
            return Promise.reject({
                error: {
                    code: 'RiskLimitDailyLoss',
                    message: `Daily loss limit reached (${limits.maxDailyLoss}). Trading paused until tomorrow.`,
                },
            });
        }
        if (state.openContracts >= limits.maxOpenContracts) {
            return Promise.reject({
                error: {
                    code: 'RiskLimitOpenContracts',
                    message: `Too many open contracts (max ${limits.maxOpenContracts}).`,
                },
            });
        }
        if (stake > limits.maxStake) {
            return Promise.reject({
                error: {
                    code: 'RiskLimitStake',
                    message: `Stake ${stake} exceeds max stake ${limits.maxStake}.`,
                },
            });
        }

        return undefined; // allow the request through unchanged
    };

    sendIsCalled = ({ response_promise, args: [request] }) => {
        const req_type = this.getRequestType(request);
        if (req_type) performance.mark(`${req_type}_start`);
        response_promise
            .then(res => {
                const res_type = this.getRequestType(res);
                if (res_type) {
                    this.defineMeasure(res_type);
                }
                if (res?.msg_type === 'buy' && res?.buy?.contract_id) {
                    recordContractOpened();
                }
                if (res?.msg_type === 'proposal_open_contract' && res?.proposal_open_contract?.is_sold) {
                    recordContractClosed(res.proposal_open_contract.profit);
                }
            })
            .catch(() => {});
        return response_promise;
    };
}

export default APIMiddleware;

/**
 * Manual Order Router — v5.5.3
 * ============================
 * Routes MANUAL (user-clicked) trades through the correct product-family
 * path on the Deriv API. Binary and forex/multipliers are DELIBERATELY
 * different code paths to satisfy the "binary and forex buttons must not
 * behave the same" requirement.
 *
 *   Binary  (R_*, 1HZ*, BOOM/CRASH)       -> buyBinary       (CALL/PUT/digit)
 *   Forex / Multipliers (frx*)             -> buyMultiplier   (MULTUP/MULTDOWN)
 *
 * All manual orders REQUIRE a live Deriv connection AND a valid auth token.
 * When the engine is running in signals-only mode (no token), every manual
 * order is refused with a structured `blocked_no_auth` reason so the UI can
 * light the corresponding red status chip.
 */
import { DerivClient } from '../lifecycle/deriv-client';
import { routeMarket }  from '../router/market-router';
import { isBinaryContract, buildBinaryOrder } from '../binary/binary-position';
import { getSymbolMeta } from '../../constants/all-symbols';

export type ManualBinaryAction = 'CALL' | 'PUT' | 'DIGITOVER' | 'DIGITUNDER' | 'DIGITMATCH' | 'DIGITDIFF';
export type ManualForexAction  = 'BUY' | 'SELL';

export interface ManualBinaryRequest {
    kind: 'binary';
    symbol: string;
    action: ManualBinaryAction;
    stake: number;
    durationTicks: number;
    barrier?: number;
    targetDigit?: number;
}

export interface ManualForexRequest {
    kind: 'forex';
    symbol: string;
    action: ManualForexAction;
    stake: number;
    multiplier: number;
    stopLossPips?: number;
    takeProfitPips?: number;
}

export type ManualOrderRequest = ManualBinaryRequest | ManualForexRequest;

export interface ManualOrderResult {
    ok: boolean;
    contractId?: string;
    buyPrice?: number;
    payout?: number;
    /** Machine-readable blocker code when ok=false. */
    reason?: 'no_client' | 'no_auth' | 'wrong_family' | 'invalid_params' | 'exchange_error';
    message?: string;
}

/**
 * Validate that the requested action's product family matches the symbol's
 * routed family. This is what prevents a "CALL" being fired at frxEURUSD or
 * a "BUY multiplier" being fired at R_100.
 */
function matchesFamily(req: ManualOrderRequest): boolean {
    const route = routeMarket(req.symbol);
    if (req.kind === 'binary' && route.kind !== 'binary') return false;
    if (req.kind === 'forex'  && route.kind !== 'forex')  return false;
    return true;
}

export async function executeManualOrder(
    deriv: DerivClient | null | undefined,
    token: string | null | undefined,
    req: ManualOrderRequest,
): Promise<ManualOrderResult> {
    if (!deriv)         return { ok: false, reason: 'no_client',   message: 'engine not started' };
    if (!token)         return { ok: false, reason: 'no_auth',     message: 'login required to execute manual trades' };
    if (!matchesFamily(req)) {
        return {
            ok: false, reason: 'wrong_family',
            message: `symbol ${req.symbol} is not a ${req.kind} instrument`,
        };
    }

    try {
        if (req.kind === 'binary') {
            const contractType: any = req.action;
            if (!isBinaryContract(contractType)) {
                return { ok: false, reason: 'invalid_params', message: `not a binary contract: ${req.action}` };
            }
            const order = buildBinaryOrder({
                symbol: req.symbol,
                contractType,
                stake: req.stake,
                durationTicks: req.durationTicks,
                barrier: req.barrier,
                targetDigit: req.targetDigit,
            });
            if (!order) return { ok: false, reason: 'invalid_params', message: 'binary params rejected by validator' };
            const r = await deriv.buyBinary({
                symbol: order.symbol,
                contractType: order.contractType as any,
                stake: order.stake,
                durationTicks: order.durationTicks,
                barrier: order.barrier,
                targetDigit: order.targetDigit,
            });
            return { ok: true, contractId: r.contractId, buyPrice: r.buyPrice, payout: r.payout };
        }

        // FOREX / multipliers — validate stake, multiplier, symbol family
        const meta = getSymbolMeta(req.symbol);
        if (!meta || meta.kind !== 'forex') {
            return { ok: false, reason: 'invalid_params', message: `no forex meta for ${req.symbol}` };
        }
        const stake = Math.max(0.35, Math.min(2000, req.stake));
        const mult  = Math.max(1,   Math.min(1000, Math.round(req.multiplier)));
        if (!Number.isFinite(stake) || !Number.isFinite(mult)) {
            return { ok: false, reason: 'invalid_params', message: 'stake/multiplier invalid' };
        }
        const r = await deriv.buyMultiplier({
            symbol: req.symbol,
            direction: req.action === 'BUY' ? 'UP' : 'DOWN',
            stake,
            multiplier: mult,
            stopLossPips: req.stopLossPips,
            takeProfitPips: req.takeProfitPips,
        });
        return { ok: true, contractId: r.contractId, buyPrice: r.buyPrice, payout: r.payout };
    } catch (e: any) {
        return { ok: false, reason: 'exchange_error', message: e?.message ?? String(e) };
    }
}

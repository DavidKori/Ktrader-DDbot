/**
 * Binary Position Engine
 * ----------------------
 * Wrapper around stake / duration / digit parameters for Deriv binary
 * contracts (CALL, PUT, DIGITMATCH, DIGITDIFF, DIGITOVER, DIGITUNDER).
 *
 * Binary contracts have no pip-stop-loss — the stake itself IS the maximum
 * loss. This module accepts:
 *
 *   - stake (already computed by the ExecutionEngine; martingale-aware)
 *   - durationTicks (from the adaptive duration planner)
 *   - contract-type-specific extras (barrier / targetDigit)
 *
 * and emits a single canonical `BinaryOrder` object that the Deriv client
 * can buy straight away.
 */
import type { ContractType } from '../regime/market-regime';

export type BinaryContractType =
    | 'CALL' | 'PUT'
    | 'DIGITMATCH' | 'DIGITDIFF' | 'DIGITOVER' | 'DIGITUNDER';

export interface BinaryOrderInputs {
    symbol: string;
    contractType: ContractType;     // narrowed below
    stake: number;
    durationTicks: number;
    barrier?: number;
    targetDigit?: number;
}

export interface BinaryOrder {
    symbol: string;
    contractType: BinaryContractType;
    stake: number;
    durationTicks: number;
    barrier?: number;
    targetDigit?: number;
    rationale: string;
}

export const isBinaryContract = (c: ContractType): c is BinaryContractType =>
    c === 'CALL' || c === 'PUT' ||
    c === 'DIGITMATCH' || c === 'DIGITDIFF' ||
    c === 'DIGITOVER'  || c === 'DIGITUNDER';

export const buildBinaryOrder = (i: BinaryOrderInputs): BinaryOrder | null => {
    if (!isBinaryContract(i.contractType)) return null;

    const stake = Math.max(0.35, Math.min(100, i.stake));   // Deriv hard limits
    const dur   = Math.max(1, Math.min(15, Math.round(i.durationTicks)));

    // Digit-contract sanity checks
    if (i.contractType === 'DIGITMATCH' || i.contractType === 'DIGITDIFF') {
        if (i.targetDigit === undefined || i.targetDigit < 0 || i.targetDigit > 9) return null;
    }
    if (i.contractType === 'DIGITOVER' || i.contractType === 'DIGITUNDER') {
        if (i.barrier === undefined || i.barrier < 1 || i.barrier > 8) return null;
    }

    return {
        symbol: i.symbol, contractType: i.contractType,
        stake, durationTicks: dur,
        barrier: i.barrier, targetDigit: i.targetDigit,
        rationale: `binary ${i.contractType} stake=$${stake.toFixed(2)} dur=${dur}t`,
    };
};

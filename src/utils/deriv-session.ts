import { PROXY_BASE } from './proxy-config';
import { safeGetItem, safeRemoveItem, safeSetItem } from './safe-storage';

export interface DerivSessionBootstrapResult {
    ok: boolean;
    active_loginid?: string;
    auth_token?: string;
    reason?: string;
}

export const hasBootstrappedDerivSession = (): boolean => {
    const token = safeGetItem('authToken');
    const loginid = safeGetItem('active_loginid');
    const accountsList = safeGetItem('accountsList');
    const clientAccounts = safeGetItem('clientAccounts');
    return !!token && !!loginid && !!accountsList && !!clientAccounts;
};

export const clearBootstrappedDerivSession = (): void => {
    [
        'accountsList',
        'clientAccounts',
        'authToken',
        'active_loginid',
        'callback_token',
        'client_account_details',
        'client.country',
    ].forEach(safeRemoveItem);
};

const SESSION_BOOTSTRAP_TIMEOUT_MS = 10000;

export async function bootstrapDerivSession(): Promise<DerivSessionBootstrapResult> {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), SESSION_BOOTSTRAP_TIMEOUT_MS);
    let response: Response;
    try {
        response = await fetch(`${PROXY_BASE}/api/deriv/me`, {
            method: 'GET',
            credentials: 'include',
            headers: { Accept: 'application/json' },
            cache: 'no-store',
            signal: controller.signal,
        });
    } catch (error) {
        const reason = error instanceof DOMException && error.name === 'AbortError'
            ? 'bootstrap_timeout'
            : error instanceof Error
              ? error.message
              : 'bootstrap_network_error';
        return { ok: false, reason };
    } finally {
        window.clearTimeout(timeoutId);
    }

    let payload: any = {};
    try {
        payload = await response.json();
    } catch {
        payload = {};
    }

    if (!response.ok) {
        // A 401 is the normal logged-out response. Remove stale client-side
        // account data so the app cannot re-enter the auth/loading loop.
        if (response.status === 401) clearBootstrappedDerivSession();
        return {
            ok: false,
            reason: payload?.error || `bootstrap_failed_${response.status}`,
        };
    }

    const loginInfo = Array.isArray(payload?.loginInfo) ? payload.loginInfo : [];
    const active_loginid = String(payload?.active_loginid || '').trim();
    const accountsList: Record<string, string> = {};
    const clientAccounts: Record<string, { loginid: string; token: string; currency: string }> = {};

    loginInfo.forEach((account: any) => {
        const loginid = String(account?.loginid || '').trim();
        const token = String(account?.token || '').trim();
        if (!loginid || !token) return;
        accountsList[loginid] = token;
        clientAccounts[loginid] = {
            loginid,
            token,
            currency: String(account?.currency || 'USD'),
        };
    });

    if (!active_loginid || !accountsList[active_loginid]) {
        return { ok: false, reason: 'no_active_options_account' };
    }

    safeSetItem('accountsList', JSON.stringify(accountsList));
    safeSetItem('clientAccounts', JSON.stringify(clientAccounts));
    safeSetItem('authToken', accountsList[active_loginid]);
    safeSetItem('active_loginid', active_loginid);
    safeSetItem('callback_token', 'deriv_oauth_session');
    safeSetItem('client_account_details', JSON.stringify(payload?.account_list || []));
    safeSetItem('client.country', String(payload?.country || ''));

    return {
        ok: true,
        active_loginid,
        auth_token: accountsList[active_loginid],
    };
}


export async function syncSelectedDerivAccount(accountId: string): Promise<void> {
    const trimmed = String(accountId || '').trim();
    if (!trimmed) return;

    const response = await fetch(`${PROXY_BASE}/api/deriv/account/select`, {
        method: 'POST',
        credentials: 'include',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ accountId: trimmed }),
    });

    if (!response.ok) {
        let payload: any = {};
        try {
            payload = await response.json();
        } catch {
            payload = {};
        }
        throw new Error(payload?.error || `account_select_failed_${response.status}`);
    }
}

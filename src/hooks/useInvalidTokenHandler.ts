import { useEffect, useRef } from 'react';
import { observer as globalObserver } from '@/external/bot-skeleton/utils/observer';
import { useOauth2 } from './auth/useOauth2';

/**
 * v5.6.2 — Debounce + gate InvalidToken before re-bouncing to /auth/deriv/login.
 *
 * v5.6.0 bug: every `InvalidToken` event from the bot-skeleton API base
 * triggered an immediate `window.location.assign` to the login URL. Right
 * after a successful OAuth round-trip, the localStorage `authToken` was
 * stale for a few hundred ms while the post-callback hydration was still
 * in flight, so the very first WS authorize() attempt fired InvalidToken
 * → reload → loop. The reload itself wiped the (re-)issued cookie, so the
 * browser never received a "fresh" logged-in session.
 *
 * v5.6.2: debounce by `INVALID_TOKEN_DEBOUNCE_MS` (3 s) and only reload
 * if `client?.is_logged_in` is still false after the timeout. The event
 * is consumed via `observer` so subsequent events in the same debounce
 * window are coalesced.
 */
const INVALID_TOKEN_DEBOUNCE_MS = 3000;

export const useInvalidTokenHandler = (): { unregisterHandler: () => void } => {
    const { retriggerOAuth2Login } = useOauth2();
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const armedRef = useRef<boolean>(true);

    const handleInvalidToken = () => {
        if (!armedRef.current) return;
        armedRef.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);
        // Try to read logged-in state. If the client store is not yet
        // available (always false at this point in real bots),
        // `client.is_logged_in` is undefined → falsy → reload.
        const clientStore = (window as any).__deriv_bot_client__;
        const stillLoggedIn = Boolean(clientStore?.is_logged_in);
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            if (stillLoggedIn) {
                armedRef.current = true;
                return;
            }
            clearLocalAuth();
            retriggerOAuth2Login();
        }, INVALID_TOKEN_DEBOUNCE_MS);
    };

    const clearLocalAuth = () => {
        try {
            localStorage.removeItem('authToken');
            localStorage.removeItem('active_loginid');
            localStorage.removeItem('clientAccounts');
            localStorage.removeItem('accountsList');
        } catch {
            /* ignore Safari ITP blocks */
        }
    };

    useEffect(() => {
        globalObserver.register('InvalidToken', handleInvalidToken);
        return () => {
            globalObserver.unregister('InvalidToken', handleInvalidToken);
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
        // retriggerOAuth2Login is stable from useOauth2 in this hook context.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return {
        unregisterHandler: () => {
            globalObserver.unregister('InvalidToken', handleInvalidToken);
        },
    };
};

export default useInvalidTokenHandler;

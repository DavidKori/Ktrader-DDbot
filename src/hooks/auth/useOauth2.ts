import { useState, useEffect } from 'react';
import Cookies from 'js-cookie';
import RootStore from '@/stores/root-store';
import { getInitialLanguage } from '@deriv-com/translations';
import { loginUrl } from '@/components/shared/utils/login/login';
import { Analytics } from '@deriv-com/analytics';
import { clearBootstrappedDerivSession } from '@/utils/deriv-session';
import { PROXY_BASE } from '@/utils/proxy-config';

type HydrationState = 'IDLE' | 'HYDRATING' | 'READY';

/**
 * v5.6.2 — Use a hydration state machine so the SSO/SLO decision only fires
 * after `/api/deriv/me` has either resolved OR observed a stable 401. The 401
 * path carries forward with `client.is_logged_in` from the server and is the
 * single source of truth for whether to flash the spinner.
 *
 * v5.6.0 bug: the effect ran on every render where `logged_state` differed
 * from `accountsList`, flashing `setIsSingleLoggingIn(true)` *before*
 * `/api/deriv/me` had a chance to populate `accountsList`, which caused the
 * infinite login → logout → login loop visible in
 * `tradewithkenbots.vercel.app`'s service worker navigation log.
 */
export const useOauth2 = ({
    handleLogout,
    client,
}: {
    handleLogout?: () => Promise<void>;
    client?: RootStore['client'];
} = {}) => {
    const [isSingleLoggingIn, setIsSingleLoggingIn] = useState(false);
    const [hydrationState, setHydrationState] = useState<HydrationState>('IDLE');
    const accountsList = JSON.parse(localStorage.getItem('accountsList') ?? '{}');
    const isClientAccountsPopulated = Object.keys(accountsList).length > 0;
    const isSilentLoginExcluded =
        window.location.pathname.includes('callback') || window.location.pathname.includes('endpoint');

    const loggedState = Cookies.get('logged_state');

    useEffect(() => {
        // Mark hydration as soon as `/api/deriv/me` finishes; the caller wires
        // `client.is_logged_in` true|false onto this via store updates. We
        // 1-shot the hydration promise so subsequent renders never re-enter.
        let cancelled = false;
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 10000);
        setHydrationState('HYDRATING');
        (async () => {
            try {
                const me = await fetch(`${PROXY_BASE}/api/deriv/me`, {
                    credentials: 'include',
                    cache: 'no-store',
                    signal: controller.signal,
                });
                if (cancelled) return;
                if (!me.ok) {
                    // 401 means not logged in; hydration is still complete.
                    clearBootstrappedDerivSession();
                    setHydrationState('READY');
                    return;
                }
                const body = await me.json().catch(() => ({}));
                if (cancelled) return;
                if (body?.accountList || body?.accountsList) {
                    localStorage.setItem('accountsList', JSON.stringify(body.accountList || body.accountsList));
                }
                setHydrationState('READY');
            } catch {
                if (!cancelled) setHydrationState('READY');
            } finally {
                window.clearTimeout(timeoutId);
            }
        })();
        return () => {
            cancelled = true;
            controller.abort();
            window.clearTimeout(timeoutId);
        };
    }, []);

    useEffect(() => {
        if (isSilentLoginExcluded || hydrationState !== 'READY') {
            // v5.6.2: don't flash the spinner until hydration completes
            setIsSingleLoggingIn(false);
            return;
        }
        const willEventuallySSO = loggedState === 'true' && !isClientAccountsPopulated;
        const willEventuallySLO = loggedState === 'false' && isClientAccountsPopulated;
        setIsSingleLoggingIn(Boolean(willEventuallySSO || willEventuallySLO));
    }, [isClientAccountsPopulated, loggedState, isSilentLoginExcluded, hydrationState]);

    useEffect(() => {
        const onUnhandled = (event: PromiseRejectionEvent) => {
            if (event?.reason?.error?.code === 'InvalidToken') {
                setIsSingleLoggingIn(false);
            }
        };
        window.addEventListener('unhandledrejection', onUnhandled);
        return () => window.removeEventListener('unhandledrejection', onUnhandled);
    }, []);

    const logoutHandler = async () => {
        client?.setIsLoggingOut(true);
        try {
            await client?.logout?.().catch(() => undefined);
            await handleLogout?.().catch(() => undefined);
            Cookies.set('logged_state', 'false', { path: '/' });
            clearBootstrappedDerivSession();
            Analytics.reset();
            window.location.assign(new URL('/auth/deriv/logout', PROXY_BASE).toString());
        } catch (error) {
            console.error('[OAuth] logout failed:', error);
        }
    };
    const retriggerOAuth2Login = async () => {
        try {
            window.location.assign(loginUrl({ language: getInitialLanguage() }));
        } catch (error) {
            console.error('[OAuth] re-login failed:', error);
        }
    };

    return { oAuthLogout: logoutHandler, retriggerOAuth2Login, isSingleLoggingIn, isOAuth2Enabled: true };
};

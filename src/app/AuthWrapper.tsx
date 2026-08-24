import React from 'react';
import ChunkLoader from '@/components/loader/chunk-loader';
import { localize, getInitialLanguage } from '@deriv-com/translations';
import { useOfflineDetection } from '@/hooks/useOfflineDetection';
import { loginUrl } from '@/components/shared/utils/login/login';
import { bootstrapDerivSession, hasBootstrappedDerivSession } from '@/utils/deriv-session';
import App from './App';

export const AuthWrapper = () => {
    const { isOnline } = useOfflineDetection();
    const [checked, setChecked] = React.useState(false);
    const [loggedIn, setLoggedIn] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;

        const bootstrap = async () => {
            const path = window.location.pathname;
            const is_bootstrap_route =
                path === '/callback' ||
                path === '/oauth/callback' ||
                path === '/endpoint' ||
                path === '/auth/deriv/callback';

            if (is_bootstrap_route) {
                if (!cancelled) {
                    setLoggedIn(true);
                    setChecked(true);
                }
                return;
            }

            try {
                const result = await bootstrapDerivSession();
                if (!cancelled) {
                    setLoggedIn(result.ok);
                    setChecked(true);
                }
                return;
            } catch {
                if (hasBootstrappedDerivSession() && !cancelled) {
                    setLoggedIn(true);
                    setChecked(true);
                    return;
                }
                if (!cancelled) {
                    setLoggedIn(false);
                    setChecked(true);
                }
            }
        };

        bootstrap();
        return () => {
            cancelled = true;
        };
    }, [isOnline]);

    if (!checked) {
        return <ChunkLoader message={localize('Please wait while we connect to the server...')} />;
    }

    if (!loggedIn) {
        return (
            <div
                style={{
                    alignItems: 'center',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '20px',
                    height: '100vh',
                    justifyContent: 'center',
                    padding: '20px',
                    textAlign: 'center',
                }}
            >
                <h1>TradeWithKen DBot</h1>
                <p>Log in with your Deriv account to continue.</p>
                <a
                    href={loginUrl({ language: getInitialLanguage() })}
                    style={{
                        background: '#ff444f',
                        borderRadius: '8px',
                        color: '#fff',
                        fontWeight: 700,
                        padding: '15px 30px',
                        textDecoration: 'none',
                    }}
                >
                    Login with Deriv
                </a>
            </div>
        );
    }

    return <App />;
};

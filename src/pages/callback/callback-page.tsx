import React from 'react';
import { Button } from '@deriv-com/ui';
import { bootstrapDerivSession } from '@/utils/deriv-session';
import { PROXY_BASE } from '@/utils/proxy-config';

const CallbackPage = () => {
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;

        const finish = async () => {
            const query = window.location.search || '';
            const params = new URLSearchParams(query);

            if (params.has('code') && params.has('state')) {
                window.location.replace(new URL(`/auth/deriv/callback${query}`, PROXY_BASE).toString());
                return;
            }

            const result = await bootstrapDerivSession();
            if (cancelled) return;

            if (result.ok) {
                window.location.replace(window.location.origin + '/');
                return;
            }

            setError(result.reason || 'Unable to complete Deriv sign-in.');
        };

        finish().catch(err => {
            if (!cancelled) {
                setError(err?.message || 'Unable to complete Deriv sign-in.');
            }
        });

        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <div
            style={{
                alignItems: 'center',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
                justifyContent: 'center',
                minHeight: '100vh',
                padding: '24px',
                textAlign: 'center',
            }}
        >
            <h1>Completing Deriv sign-in…</h1>
            <p>{error || 'Please wait while your session is being prepared.'}</p>
            <Button onClick={() => window.location.replace('/')}>Return to Bot</Button>
        </div>
    );
};

export default CallbackPage;

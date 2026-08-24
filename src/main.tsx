import ReactDOM from 'react-dom/client';
import { AuthWrapper } from './app/AuthWrapper';
import { AnalyticsInitializer } from './utils/analytics';
import { registerPWA } from './utils/pwa-utils';
import { installEngineHook } from './components/twk-overlay/engine-boot';
import './styles/index.scss';

AnalyticsInitializer();
// TradeWithKen — install engine hook so overlay "Start Auto-Trade" boots orchestrator
if (typeof window !== 'undefined') {
    // Defer until DOM ready so window/document/localStorage are all present
    setTimeout(() => { try { installEngineHook(); } catch (e) { console.warn('[TWK] engine-hook install failed', e); } }, 0);
}
registerPWA()
    .then(registration => {
        if (registration) {
            console.log('PWA service worker registered successfully for Chrome');
        } else {
            console.log('PWA service worker disabled for non-Chrome browser');
        }
    })
    .catch(error => {
        console.error('PWA service worker registration failed:', error);
    });

ReactDOM.createRoot(document.getElementById('root')!).render(<AuthWrapper />);

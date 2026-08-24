/**
 * TradeWithKen Footer
 * -------------------
 * WhatsApp + Call + Telegram contact tiles + brand line.
 * The phone number is hard-coded as per spec.
 */
import React from 'react';
import { TradeWithKenLogo } from '../logo/TradeWithKenLogo';

const PHONE = '+254702544088';
const PHONE_INTL = PHONE.replace(/[^0-9]/g, '');     // 254702544088

const tileStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 10,
    padding: '10px 14px', borderRadius: 14,
    background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.10)',
    color: '#f4f0ff', textDecoration: 'none', fontSize: 14, fontWeight: 600,
    transition: 'all .2s ease', backdropFilter: 'blur(8px)',
};

const IconWA = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="#25D366" aria-hidden>
        <path d="M20.52 3.48A11.93 11.93 0 0012.05 0C5.49 0 .14 5.35.14 11.92c0 2.1.55 4.15 1.6 5.96L0 24l6.3-1.65a11.9 11.9 0 005.74 1.46h.01c6.56 0 11.91-5.35 11.91-11.92 0-3.18-1.24-6.17-3.44-8.41zM12.05 21.8h-.01a9.85 9.85 0 01-5.02-1.37l-.36-.22-3.74.98 1-3.64-.24-.37a9.84 9.84 0 01-1.5-5.26C2.18 6.51 6.6 2.1 12.06 2.1c2.64 0 5.12 1.03 6.98 2.9a9.83 9.83 0 012.89 6.99c0 5.46-4.42 9.81-9.88 9.81zm5.42-7.36c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.66.15-.2.3-.76.97-.93 1.17-.17.2-.34.22-.64.07-.3-.15-1.25-.46-2.38-1.47-.88-.78-1.47-1.74-1.64-2.04-.17-.3-.02-.46.13-.61.13-.13.3-.34.45-.51.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.66-1.6-.9-2.18-.24-.58-.49-.5-.66-.51l-.56-.01a1.07 1.07 0 00-.78.37c-.27.3-1.02 1-1.02 2.44s1.04 2.83 1.19 3.03c.15.2 2.05 3.14 4.97 4.4.7.3 1.24.48 1.66.62.7.22 1.33.19 1.83.12.56-.08 1.76-.72 2.01-1.42.25-.7.25-1.3.17-1.42-.07-.12-.27-.2-.57-.35z"/>
    </svg>
);
const IconCall = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="#43f3ff" aria-hidden>
        <path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.05-.24 11.36 11.36 0 003.58.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.36 11.36 0 00.57 3.58 1 1 0 01-.25 1.05z"/>
    </svg>
);
const IconTG = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="#229ED9" aria-hidden>
        <path d="M22 2L2 10.5l5.5 2L10 21l3.5-5.5L19 19l3-17zM9 14.5l8.5-7-6.5 7.7v3l-2-3.7z"/>
    </svg>
);

export const TradeWithKenFooter: React.FC = () => {
    return (
        <footer style={{
            marginTop: 32,
            padding: '32px 24px',
            background: 'linear-gradient(180deg, rgba(8,5,16,0.4), rgba(8,5,16,0.85))',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            color: '#b8acd8',
        }}>
            <div style={{ maxWidth: 1280, margin: '0 auto',
                          display: 'flex', flexWrap: 'wrap', gap: 24,
                          justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                    <TradeWithKenLogo size={42} />
                    <div style={{ marginTop: 10, fontSize: 13, opacity: .8, maxWidth: 360 }}>
                        AI-assisted Deriv trading dashboard. Forex multipliers + binary
                        synthetics powered by a LightGBM probability engine.
                    </div>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                    <a style={tileStyle} href={`https://wa.me/${PHONE_INTL}`}
                       target="_blank" rel="noopener noreferrer">
                        <IconWA /> <span>WhatsApp</span>
                        <span style={{ opacity:.7, fontWeight:400 }}>{PHONE}</span>
                    </a>
                    <a style={tileStyle} href={`tel:${PHONE}`}>
                        <IconCall /> <span>Call</span>
                        <span style={{ opacity:.7, fontWeight:400 }}>{PHONE}</span>
                    </a>
                    <a style={tileStyle} href={`https://t.me/${PHONE_INTL}`}
                       target="_blank" rel="noopener noreferrer">
                        <IconTG /> <span>Telegram</span>
                        <span style={{ opacity:.7, fontWeight:400 }}>{PHONE}</span>
                    </a>
                </div>
            </div>

            <div style={{ maxWidth: 1280, margin: '20px auto 0',
                          borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 14,
                          fontSize: 12, opacity: .7, display: 'flex',
                          justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <span>© {new Date().getFullYear()} TradeWithKen · All rights reserved</span>
                <span>Trading carries risk. Use demo accounts before going live.</span>
            </div>
        </footer>
    );
};

export default TradeWithKenFooter;

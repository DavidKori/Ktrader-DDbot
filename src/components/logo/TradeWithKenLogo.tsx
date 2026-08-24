/**
 * TradeWithKen Logo
 * Drop the PNG at `/public/assets/tradewithken-logo.png` (already bundled).
 * Also exposes a pure-SVG inline fallback so the logo never breaks.
 */
import React from 'react';

interface Props { size?: number; withText?: boolean; href?: string; }

export const TradeWithKenLogo: React.FC<Props> = ({ size = 40, withText = true, href = '/' }) => (
    <a href={href} style={{ display: 'inline-flex', alignItems: 'center', gap: 10,
                            textDecoration: 'none', color: 'inherit' }}>
        <svg width={size} height={size} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="twkg" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%"  stopColor="#7c3aed"/>
                    <stop offset="60%" stopColor="#16a34a"/>
                    <stop offset="100%" stopColor="#43f3ff"/>
                </linearGradient>
            </defs>
            <polygon points="32,2 60,18 60,46 32,62 4,46 4,18"
                     fill="url(#twkg)" stroke="rgba(255,255,255,.2)" strokeWidth="1.5"/>
            <path d="M14 44 L24 32 L32 38 L42 22 L52 28"
                  stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            <circle cx="52" cy="28" r="3" fill="#ffffff"/>
        </svg>
        {withText && (
            <span style={{ fontFamily: 'Orbitron, sans-serif', fontWeight: 800, fontSize: 14,
                           letterSpacing: '0.16em', textTransform: 'uppercase',
                           background: 'linear-gradient(90deg,#7c3aed,#16a34a,#43f3ff)',
                           WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                TradeWithKen
            </span>
        )}
    </a>
);

export default TradeWithKenLogo;

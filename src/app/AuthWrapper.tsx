import React from 'react';
import ChunkLoader from '@/components/loader/chunk-loader';
import { localize, getInitialLanguage } from '@deriv-com/translations';
import { useOfflineDetection } from '@/hooks/useOfflineDetection';
import { loginUrl } from '@/components/shared/utils/login/login';
import { bootstrapDerivSession, hasBootstrappedDerivSession } from '@/utils/deriv-session';
import App from './App';

// --- Inline SVG Icons ---
const ChevronDown = () => (
    <svg
        width='20'
        height='20'
        viewBox='0 0 24 24'
        fill='none'
        stroke='currentColor'
        strokeWidth='2'
        strokeLinecap='round'
        strokeLinejoin='round'
    >
        <polyline points='6 9 12 15 18 9'></polyline>
    </svg>
);
const ShieldIcon = () => (
    <svg
        width='24'
        height='24'
        viewBox='0 0 24 24'
        fill='none'
        stroke='var(--accent-green)'
        strokeWidth='2'
        strokeLinecap='round'
        strokeLinejoin='round'
    >
        <path d='M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'></path>
    </svg>
);
const ChartIcon = () => (
    <svg
        width='24'
        height='24'
        viewBox='0 0 24 24'
        fill='none'
        stroke='var(--accent-blue)'
        strokeWidth='2'
        strokeLinecap='round'
        strokeLinejoin='round'
    >
        <line x1='18' y1='20' x2='18' y2='10'></line>
        <line x1='12' y1='20' x2='12' y2='4'></line>
        <line x1='6' y1='20' x2='6' y2='14'></line>
    </svg>
);
const BookIcon = () => (
    <svg
        width='24'
        height='24'
        viewBox='0 0 24 24'
        fill='none'
        stroke='#ffffff'
        strokeWidth='2'
        strokeLinecap='round'
        strokeLinejoin='round'
    >
        <path d='M4 19.5A2.5 2.5 0 0 1 6.5 17H20'></path>
        <path d='M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'></path>
    </svg>
);

const faqs = [
    {
        question: 'What is Ktraders?',
        answer: 'Ktraders is a streamlined trading platform powered by Deriv. We provide the tools, analytics, and educational resources you need to trade global financial markets confidently.',
    },
    {
        question: 'How do I create an account?',
        answer: "You don't need a separate account! Simply click 'Login with Deriv' and use your existing Deriv credentials to securely access your Ktraders dashboard.",
    },
    {
        question: 'Is my money safe?',
        answer: "Absolutely. All financial transactions and data handling are managed securely through Deriv's established, regulated infrastructure.",
    },
    {
        question: 'Do I need trading experience?',
        answer: "Not at all. We offer a built-in, bite-sized 'Fast Track' course inside the dashboard to teach you the basics, how to read charts, and how to manage your risk.",
    },
];

export const AuthWrapper = () => {
    const { isOnline } = useOfflineDetection();
    const [checked, setChecked] = React.useState(false);
    const [loggedIn, setLoggedIn] = React.useState(false);
    const [openFaq, setOpenFaq] = React.useState<number | null>(null);

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

    const toggleFaq = (index: number) => {
        setOpenFaq(openFaq === index ? null : index);
    };

    if (!checked) {
        return <ChunkLoader message={localize('Please wait while we connect to the server...')} />;
    }

    if (!loggedIn) {
        return (
            <div className='ktraders-app'>
                {/* --- Global Styles for Landing Page --- */}
                <style>{`
                    :root {
                        --bg-dark: #070b14;
                        --surface-dark: #0f1626;
                        --text-main: #ffffff;
                        --text-muted: #94a3b8;
                        --accent-blue: #00a2ff;
                        --accent-green: #00ff88;
                        --gradient-brand: linear-gradient(135deg, var(--accent-blue) 0%, var(--accent-green) 100%);
                    }
                    .ktraders-app {
                        background-color: var(--bg-dark);
                        color: var(--text-main);
                        font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                        min-height: 100vh;
                        overflow-x: hidden;
                    }
                    /* Navbar */
                    .navbar {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        padding: 1.5rem 5%;
                        position: absolute;
                        top: 0;
                        width: 100%;
                        box-sizing: border-box;
                        z-index: 10;
                    }
                    .nav-logo {
                        height: 40px;
                        object-fit: contain;
                    }
                    /* Hero */
                    .hero-section {
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        text-align: center;
                        padding: 8rem 1rem 4rem;
                        min-height: 80vh;
                        position: relative;
                    }
                    .hero-section::before {
                        content: '';
                        position: absolute;
                        top: -20%;
                        left: 50%;
                        transform: translateX(-50%);
                        width: 600px;
                        height: 600px;
                        background: radial-gradient(circle, rgba(0, 162, 255, 0.15) 0%, rgba(0, 255, 136, 0.05) 50%, transparent 70%);
                        z-index: 0;
                        pointer-events: none;
                    }
                    .hero-content {
                        position: relative;
                        z-index: 1;
                        max-width: 800px;
                    }
                    .hero-badge {
                        display: inline-block;
                        background: rgba(255, 255, 255, 0.05);
                        border: 1px solid rgba(255, 255, 255, 0.1);
                        padding: 0.5rem 1rem;
                        border-radius: 50px;
                        font-size: 0.85rem;
                        font-weight: 600;
                        color: var(--accent-green);
                        margin-bottom: 1.5rem;
                        letter-spacing: 0.5px;
                    }
                    .hero-title {
                        font-size: 3.5rem;
                        font-weight: 800;
                        line-height: 1.2;
                        margin-bottom: 1.5rem;
                        letter-spacing: -1px;
                    }
                    .text-gradient {
                        background: var(--gradient-brand);
                        -webkit-background-clip: text;
                        -webkit-text-fill-color: transparent;
                        background-clip: text;
                    }
                    .hero-subtitle {
                        font-size: 1.125rem;
                        color: var(--text-muted);
                        line-height: 1.6;
                        margin-bottom: 2.5rem;
                        max-width: 600px;
                        margin-left: auto;
                        margin-right: auto;
                    }
                    .hero-cta-group {
                        display: flex;
                        gap: 1rem;
                        justify-content: center;
                        flex-wrap: wrap;
                    }
                    /* Buttons */
                    .btn-primary {
                        background: #ff444f;
                        color: #fff;
                        border: none;
                        border-radius: 8px;
                        padding: 0.75rem 1.5rem;
                        font-weight: 700;
                        font-size: 1rem;
                        cursor: pointer;
                        text-decoration: none;
                        transition: opacity 0.2s;
                    }
                    .btn-primary:hover { opacity: 0.9; }
                    .btn-primary-large {
                        background: #ff444f;
                        color: #fff;
                        border: none;
                        border-radius: 8px;
                        padding: 1rem 2rem;
                        font-weight: 700;
                        font-size: 1.1rem;
                        cursor: pointer;
                        text-decoration: none;
                        transition: opacity 0.2s;
                    }
                    .btn-primary-large:hover { opacity: 0.9; }
                    .btn-secondary-large {
                        background: transparent;
                        color: #fff;
                        border: 1px solid rgba(255, 255, 255, 0.2);
                        border-radius: 8px;
                        padding: 1rem 2rem;
                        font-weight: 600;
                        font-size: 1.1rem;
                        cursor: pointer;
                        text-decoration: none;
                        transition: background 0.2s;
                    }
                    .btn-secondary-large:hover { background: rgba(255, 255, 255, 0.05); }
                    
                    /* Sections Global */
                    .section-header {
                        text-align: center;
                        margin-bottom: 3rem;
                    }
                    .section-header h2 {
                        font-size: 2rem;
                        font-weight: 700;
                        margin-bottom: 0.5rem;
                    }
                    .section-header p {
                        color: var(--text-muted);
                        font-size: 1rem;
                    }
                    /* Features */
                    .features-section {
                        padding: 4rem 5%;
                        max-width: 1200px;
                        margin: 0 auto;
                    }
                    .features-grid {
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                        gap: 2rem;
                    }
                    .feature-card {
                        background: var(--surface-dark);
                        border: 1px solid rgba(255, 255, 255, 0.05);
                        border-radius: 16px;
                        padding: 2rem;
                        transition: transform 0.2s, border-color 0.2s;
                    }
                    .feature-card:hover {
                        transform: translateY(-5px);
                        border-color: rgba(0, 162, 255, 0.3);
                    }
                    .icon-wrapper {
                        width: 48px;
                        height: 48px;
                        border-radius: 12px;
                        background: rgba(255, 255, 255, 0.05);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        margin-bottom: 1.5rem;
                    }
                    .feature-card h3 {
                        font-size: 1.25rem;
                        margin-bottom: 1rem;
                    }
                    .feature-card p {
                        color: var(--text-muted);
                        line-height: 1.6;
                        font-size: 0.95rem;
                    }
                    /* Course */
                    .course-section {
                        padding: 4rem 5%;
                        background: linear-gradient(180deg, var(--bg-dark) 0%, rgba(15, 22, 38, 0.5) 100%);
                    }
                    .course-container {
                        max-width: 1000px;
                        margin: 0 auto;
                        display: grid;
                        grid-template-columns: 1fr 1fr;
                        gap: 4rem;
                        align-items: center;
                    }
                    .course-text h2 {
                        font-size: 2.2rem;
                        line-height: 1.3;
                        margin-bottom: 1rem;
                    }
                    .course-text p {
                        color: var(--text-muted);
                        margin-bottom: 2rem;
                        line-height: 1.6;
                    }
                    .course-modules {
                        display: flex;
                        flex-direction: column;
                        gap: 1.5rem;
                    }
                    .module-item {
                        display: flex;
                        gap: 1.5rem;
                        align-items: flex-start;
                        background: rgba(255, 255, 255, 0.02);
                        padding: 1.5rem;
                        border-radius: 12px;
                        border-left: 2px solid var(--accent-blue);
                    }
                    .module-number {
                        font-size: 1.5rem;
                        font-weight: 800;
                        color: rgba(255, 255, 255, 0.1);
                        line-height: 1;
                    }
                    .module-item h4 {
                        font-size: 1.1rem;
                        margin-bottom: 0.25rem;
                    }
                    .module-item p {
                        font-size: 0.9rem;
                        margin-bottom: 0;
                    }
                    /* FAQ */
                    .faq-section {
                        padding: 4rem 5%;
                        max-width: 800px;
                        margin: 0 auto;
                    }
                    .faq-accordion {
                        display: flex;
                        flex-direction: column;
                        gap: 1rem;
                    }
                    .faq-item {
                        background: var(--surface-dark);
                        border: 1px solid rgba(255, 255, 255, 0.05);
                        border-radius: 12px;
                        overflow: hidden;
                        cursor: pointer;
                        transition: border-color 0.2s;
                    }
                    .faq-item:hover {
                        border-color: rgba(0, 255, 136, 0.3);
                    }
                    .faq-question {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        padding: 1.5rem;
                    }
                    .faq-question h3 {
                        font-size: 1.1rem;
                        font-weight: 600;
                        margin: 0;
                    }
                    .faq-icon {
                        transition: transform 0.3s ease;
                        color: var(--text-muted);
                    }
                    .faq-item.open .faq-icon {
                        transform: rotate(180deg);
                        color: var(--accent-green);
                    }
                    .faq-answer {
                        max-height: 0;
                        overflow: hidden;
                        transition: max-height 0.3s ease, padding 0.3s ease;
                        padding: 0 1.5rem;
                    }
                    .faq-item.open .faq-answer {
                        max-height: 200px;
                        padding: 0 1.5rem 1.5rem;
                    }
                    .faq-answer p {
                        color: var(--text-muted);
                        line-height: 1.6;
                        margin: 0;
                    }
                    /* Responsive */
                    @media (max-width: 768px) {
                        .hero-title { font-size: 2.5rem; }
                        .course-container { grid-template-columns: 1fr; gap: 2rem; }
                        .navbar { padding: 1rem 5%; }
                    }
                `}</style>

                {/* --- Navbar --- */}
                <nav className='navbar'>
                    <div className='logo-container'>
                        {/* Replace with your actual logo image path */}
                        <img
                            src='https://res.cloudinary.com/dxritu7i3/image/upload/v1788596772/KtradersLogo_znlyis.png'
                            alt='Ktraders Logo'
                            className='nav-logo'
                        />
                    </div>
                    <a href={loginUrl({ language: getInitialLanguage() })} className='btn-primary'>
                        Login to Trade
                    </a>
                </nav>

                {/* --- Hero Section --- */}
                <header className='hero-section'>
                    <div className='hero-content'>
                        <div className='hero-badge'>Powered by Deriv</div>
                        <h1 className='hero-title'>
                            Trade Smart. <span className='text-gradient'>Move Ahead.</span>
                        </h1>
                        <p className='hero-subtitle'>
                            Experience institutional-grade trading simplified. Join Ktraders today to access global
                            markets, learn proven strategies, and take control of your financial freedom.
                        </p>
                        <div className='hero-cta-group'>
                            <a href={loginUrl({ language: getInitialLanguage() })} className='btn-primary-large'>
                                Start Trading Now
                            </a>
                            <a href='#course' className='btn-secondary-large'>
                                Learn How It Works
                            </a>
                        </div>
                    </div>
                    <marquee
                        behavior='scroll'
                        direction='left'
                        style={{ marginTop: '5%', color: 'var(--accent-blue)', fontSize: '30px' }}
                    >
                        Welcome to Ktraders! Trade with confidence and join our community of successful traders.
                    </marquee>
                </header>

                {/* --- Trust & Features Section --- */}
                <section className='features-section'>
                    <div className='section-header'>
                        <h2>Why Choose Ktraders?</h2>
                        <p>A streamlined experience built for both beginners and seasoned traders.</p>
                    </div>
                    <div className='features-grid'>
                        <div className='feature-card'>
                            <div className='icon-wrapper'>
                                <ShieldIcon />
                            </div>
                            <h3>Secure & Reliable</h3>
                            <p>
                                Your funds and data are protected by top-tier security protocols, fully integrated with
                                Deriv's trusted infrastructure.
                            </p>
                        </div>
                        <div className='feature-card'>
                            <div className='icon-wrapper'>
                                <ChartIcon />
                            </div>
                            <h3>Advanced Tools</h3>
                            <p>
                                Access real-time charts, technical indicators, and fast execution speeds to capitalize
                                on market movements.
                            </p>
                        </div>
                        <div className='feature-card'>
                            <div className='icon-wrapper'>
                                <BookIcon />
                            </div>
                            <h3>Learn While You Earn</h3>
                            <p>
                                Don't just trade—understand the market. Get access to our exclusive, easy-to-follow
                                structured trading course.
                            </p>
                        </div>
                    </div>
                </section>

                {/* --- Micro Course Section --- */}
                <section id='course' className='course-section'>
                    <div className='course-container'>
                        <div className='course-text'>
                            <h2>
                                New to Trading? <br />
                                <span className='text-gradient'>We've Got You Covered.</span>
                            </h2>
                            <p>
                                Skip the confusion. Our bite-sized "Fast Track" course gives you the exact blueprint you
                                need to start trading confidently today.
                            </p>
                            <a href={loginUrl({ language: getInitialLanguage() })} className='btn-primary'>
                                Access Course in Dashboard
                            </a>
                        </div>
                        <div className='course-modules'>
                            <div className='module-item'>
                                <span className='module-number'>01</span>
                                <div>
                                    <h4>The Basics of Deriv</h4>
                                    <p>Setting up your account and understanding the interface safely.</p>
                                </div>
                            </div>
                            <div className='module-item'>
                                <span className='module-number'>02</span>
                                <div>
                                    <h4>Reading the Charts</h4>
                                    <p>Simple technical analysis to identify profitable trends.</p>
                                </div>
                            </div>
                            <div className='module-item'>
                                <span className='module-number'>03</span>
                                <div>
                                    <h4>Risk Management</h4>
                                    <p>How to protect your capital and trade smartly.</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                {/* --- FAQ Section --- */}
                <section className='faq-section'>
                    <div className='section-header'>
                        <h2>Frequently Asked Questions</h2>
                        <p>Everything you need to know before getting started.</p>
                    </div>
                    <div className='faq-accordion'>
                        {faqs.map((faq, index) => (
                            <div
                                key={index}
                                className={`faq-item ${openFaq === index ? 'open' : ''}`}
                                onClick={() => toggleFaq(index)}
                            >
                                <div className='faq-question'>
                                    <h3>{faq.question}</h3>
                                    <span className='faq-icon'>
                                        <ChevronDown />
                                    </span>
                                </div>
                                <div className='faq-answer'>
                                    <p>{faq.answer}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            </div>
        );
    }

    return <App />;
};

// import React from 'react';
// import ChunkLoader from '@/components/loader/chunk-loader';
// import { localize, getInitialLanguage } from '@deriv-com/translations';
// import { useOfflineDetection } from '@/hooks/useOfflineDetection';
// import { loginUrl } from '@/components/shared/utils/login/login';
// import { bootstrapDerivSession, hasBootstrappedDerivSession } from '@/utils/deriv-session';
// import App from './App';

// export const AuthWrapper = () => {
//     const { isOnline } = useOfflineDetection();
//     const [checked, setChecked] = React.useState(false);
//     const [loggedIn, setLoggedIn] = React.useState(false);

//     React.useEffect(() => {
//         let cancelled = false;

//         const bootstrap = async () => {
//             const path = window.location.pathname;
//             const is_bootstrap_route =
//                 path === '/callback' ||
//                 path === '/oauth/callback' ||
//                 path === '/endpoint' ||
//                 path === '/auth/deriv/callback';

//             if (is_bootstrap_route) {
//                 if (!cancelled) {
//                     setLoggedIn(true);
//                     setChecked(true);
//                 }
//                 return;
//             }

//             try {
//                 const result = await bootstrapDerivSession();
//                 if (!cancelled) {
//                     setLoggedIn(result.ok);
//                     setChecked(true);
//                 }
//                 return;
//             } catch {
//                 if (hasBootstrappedDerivSession() && !cancelled) {
//                     setLoggedIn(true);
//                     setChecked(true);
//                     return;
//                 }
//                 if (!cancelled) {
//                     setLoggedIn(false);
//                     setChecked(true);
//                 }
//             }
//         };

//         bootstrap();
//         return () => {
//             cancelled = true;
//         };
//     }, [isOnline]);

//     if (!checked) {
//         return <ChunkLoader message={localize('Please wait while we connect to the server...')} />;
//     }

//     if (loggedIn) {
//         return (
//             <div
//                 style={{
//                     alignItems: 'center',
//                     display: 'flex',
//                     flexDirection: 'column',
//                     gap: '20px',
//                     height: '100vh',
//                     justifyContent: 'center',
//                     padding: '20px',
//                     textAlign: 'center',
//                 }}
//             >
//                 <h1>Ktraders</h1>
//                 <p>Log in with your Deriv account to continue.</p>
//                 <a
//                     href={loginUrl({ language: getInitialLanguage() })}
//                     style={{
//                         background: '#ff444f',
//                         borderRadius: '8px',
//                         color: '#fff',
//                         fontWeight: 700,
//                         padding: '15px 30px',
//                         textDecoration: 'none',
//                     }}
//                 >
//                     Login with Deriv
//                 </a>
//             </div>
//         );
//     }

//     return <App />;
// };

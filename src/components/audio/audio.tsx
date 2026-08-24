/* eslint-disable react/react-in-jsx-scope */
/**
 * Audio elements — v5.5.4
 * =======================
 * - preload="none" so the browser does NOT fetch the mp3 until a play() call.
 *   This eliminates the "503 Service Unavailable" console spam that occurs
 *   when Vercel's edge cache hasn't warmed the audio bundle yet.
 * - onError swallows fetch failures. Sound is a cosmetic UX detail, never a
 *   blocker for trading.
 */
const suppress: React.ReactEventHandler<HTMLAudioElement> = e => {
    e.preventDefault();
    e.stopPropagation();
    // Optionally clear the src so retry attempts stop firing
    try { (e.currentTarget as HTMLAudioElement).removeAttribute('src'); } catch { /* ignore */ }
};

const Audio = () => (
    <>
        <audio
            id='announcement'
            aria-label='audio'
            preload='none'
            onError={suppress}
            src={`${window.__webpack_public_path__}assets/media/announcement.mp3`}
        />
        <audio id='earned-money' aria-label='audio' preload='none' onError={suppress}
            src={`${window.__webpack_public_path__}assets/media/coins.mp3`} />
        <audio id='job-done' aria-label='audio' preload='none' onError={suppress}
            src={`${window.__webpack_public_path__}assets/media/job-done.mp3`} />
        <audio id='error' aria-label='audio' preload='none' onError={suppress}
            src={`${window.__webpack_public_path__}assets/media/out-of-bounds.mp3`} />
        <audio
            id='severe-error'
            aria-label='audio'
            preload='none'
            onError={suppress}
            src={`${window.__webpack_public_path__}assets/media/i-am-being-serious.mp3`}
        />
    </>
);

export default Audio;

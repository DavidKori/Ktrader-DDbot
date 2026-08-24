/**
 * Safe localStorage wrapper — v5.5.4
 * ===================================
 * Edge's Enhanced Tracking Prevention and Safari's Intelligent Tracking
 * Prevention selectively BLOCK localStorage access on third-party or
 * non-first-party contexts. When that happens, `localStorage.getItem` /
 * `setItem` throws a SecurityError instead of returning null.
 *
 * The console log the user reported (`Tracking Prevention blocked access
 * to storage for <URL>`) is exactly this class of error and it was
 * causing the login/authToken persistence to appear broken on
 * <your-vercel-domain> even after a successful OAuth handshake.
 *
 * This module provides:
 *   - safeGetItem / safeSetItem / safeRemoveItem : same signature as
 *     localStorage but never throws
 *   - An in-memory fallback map that persists for the tab session when
 *     the browser blocks localStorage entirely
 *   - safeGetJSON / safeSetJSON helpers for object values
 *   - `isStorageAvailable()` probe (once-cached)
 *
 * All existing code can migrate incrementally by swapping
 *   localStorage.getItem('foo')  ->  safeGetItem('foo')
 *   localStorage.setItem('foo',v) ->  safeSetItem('foo', v)
 */

const memoryStore = new Map<string, string>();
let storageOk: boolean | undefined;

export function isStorageAvailable(): boolean {
    if (storageOk !== undefined) return storageOk;
    try {
        if (typeof window === 'undefined' || !window.localStorage) {
            storageOk = false;
            return false;
        }
        const probe = '__twk_probe__';
        window.localStorage.setItem(probe, '1');
        window.localStorage.removeItem(probe);
        storageOk = true;
    } catch {
        storageOk = false;
    }
    return storageOk;
}

export function safeGetItem(key: string): string | null {
    if (isStorageAvailable()) {
        try {
            const v = window.localStorage.getItem(key);
            if (v !== null) return v;
        } catch { /* fall through to memory */ }
    }
    return memoryStore.has(key) ? memoryStore.get(key)! : null;
}

export function safeSetItem(key: string, value: string): boolean {
    memoryStore.set(key, value);        // always mirror to memory so reads within the tab still work
    if (isStorageAvailable()) {
        try {
            window.localStorage.setItem(key, value);
            return true;
        } catch { /* blocked mid-session — memoryStore is still populated */ }
    }
    return false;
}

export function safeRemoveItem(key: string): void {
    memoryStore.delete(key);
    if (isStorageAvailable()) {
        try { window.localStorage.removeItem(key); } catch { /* ignore */ }
    }
}

export function safeGetJSON<T = any>(key: string, fallback: T): T {
    const raw = safeGetItem(key);
    if (raw === null) return fallback;
    try { return JSON.parse(raw) as T; }
    catch { return fallback; }
}

export function safeSetJSON(key: string, value: unknown): boolean {
    try { return safeSetItem(key, JSON.stringify(value)); }
    catch { return false; }
}

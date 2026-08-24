// The app ID is resolved elsewhere. Keep this helper as a no-op so existing
// call sites do not need to change while the authenticated session is now
// established through the server-backed Deriv bridge.
export const ensureDerivAppIdConfigured = (): void => {
    // Intentionally a no-op — see comment above.
};

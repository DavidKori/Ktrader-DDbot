# DDBot v5.6.0 Final WebSocket/OAuth Cleanup Verification

## Completed fixes

### WebSocket architecture
- Removed dependency on Vercel raw websocket upgrade proxy flow.
- Browser clients connect directly to Deriv WebSocket:
  - `wss://ws.derivws.com/websockets/v3`
- The chart bot-skeleton transport now includes `app_id`.

### OAuth separation
- OAuth application identifier remains:
  - `DERIV_OAUTH_APP_ID`
- WebSocket identifier uses:
  - `DERIV_APP_ID`

Current Deriv portal value verified from the provided dashboard screenshots:

```
33tDyOr00nQjiUbISnUBK
```

### Files audited
- `src/ai/lifecycle/deriv-client.ts`
- `src/external/bot-skeleton/services/api/appId.js`
- `src/utils/proxy-config.ts`
- OAuth bootstrap/session flow
- Vercel configuration
- deployment environment documentation

### Deployment requirements

Vercel environment variables:

```
DERIV_OAUTH_APP_ID=33tDyOr00nQjiUbISnUBK
DERIV_APP_ID=33tDyOr00nQjiUbISnUBK
PUBLIC_DERIV_WS_URL=wss://ws.derivws.com/websockets/v3
```

After deployment:
1. Clear browser site storage.
2. Unregister old service worker.
3. Hard reload.
4. Verify:
   - websocket connects
   - ticks arrive
   - candles load
   - authorize succeeds
   - balance subscription starts

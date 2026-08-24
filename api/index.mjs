// ============================================================================
// Vercel Function entry point (v5.6.0-refined-2).
// ----------------------------------------------------------------------------
// What changed vs the prior refined zip:
//
//   1. `export default server` (raw http.Server) → `export default app` (the
//      Express app). Vercel serverless functions must export a (req,res)
//      handler; the http.Server default caused the function runtime to be
//      rejected at instantiate time on some node-runtime builds.
//
//   2. We still export `server` as a named export so the same module stays
//      usable as the standalone-Node entry in non-Vercel environments.
//
// Why `functions` block was removed from vercel.json:
//   `runtime: "@vercel/node@5"` is the short-name shorthand Vercel rejects:
//     Error: Function Runtimes must have a valid version, for example  
//            `now-php@1.0.0`.
//   The clean fix is to delete the `functions` block entirely; Vercel
//   auto-detects Node from `api/*.mjs` and applies the current pinned
//   runtime version configured at the project level. Adding `engines.node`
//   in package.json (already set to "24.x") further pins the Node version.
// ============================================================================
import { app, server } from '../server-node/index.js';

export { app, server };
export default app;


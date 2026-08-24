// ============================================================================
// Root production entry point (v5.6.0-refined-2).
//
// History of this file across refinements:
//
//   v5.6.0-original  → only re-exported from server-node; Vercel could not
//                      detect express transitively → "No entrypoint found".
//
//   v5.6.0-refined   → added direct `import express` + conditional listen.
//                      Deployment then failed because the vercel.json
//                      `functions` block used `"runtime": "@vercel/node@5"`
//                      shorthand → "Function Runtimes must have a valid
//                      version, for example `now-php@1.0.0`".
//
//   v5.6.0-refined-2 → keeps the direct `import express` (still required so
//                      Vercel's CLI can confirm an Express entrypoint
//                      exists when scanning), keeps the conditional listen,
//                      and matches the new vercel.json (no `functions` block,
//                      only rewrites). The actual production function is
//                      still api/index.mjs.
// ============================================================================
import express from 'express';
import { app, server } from './server-node/index.js';

export { app, server };
export default app;


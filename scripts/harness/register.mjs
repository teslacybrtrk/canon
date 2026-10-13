// Loads the judge in Node for method-level tests: `cloudflare:workers` resolves to a stand-in (the DurableObject base
// class the judge extends), and the judge's extensionless relative imports ("./ledger") resolve to their .ts files, as
// wrangler's bundler resolves them. Used as: node --import ./scripts/harness/register.mjs <test>
import { registerHooks } from "node:module";
const STUB = "data:text/javascript," + encodeURIComponent("export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: STUB, shortCircuit: true };
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
      try { return next(`${specifier}.ts`, context); } catch {}
    }
    return next(specifier, context);
  },
});

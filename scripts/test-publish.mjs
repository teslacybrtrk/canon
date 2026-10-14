// The deploy token against files an attempt controls, on this machine, with a FAKE token (never a real one). An attempt
// plants a .env pointing wrangler's API at a listener here. The way previews used to be published (wrangler in the
// attempt's checkout, holding the token) sends the token to that listener; the build-then-publish split
// (referee/src/publish.ts: bundle without credentials, upload from an empty directory with the owner's config) doesn't.
//   node scripts/test-publish.mjs      (needs demo-app/node_modules; the split's upload reaches api.cloudflare.com and
//                                       is refused there, since the token is fake)
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScript, bundleEnv, bundleOf, checkBundle, publishScript, publishTarget, WRANGLER } from "../referee/src/publish.ts";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const FAKE = "canon-test-token-not-real-0123456789";
const seen = [];
const listener = createServer((req, res) => {
  seen.push(String(req.headers.authorization ?? ""));
  res.writeHead(401, { "content-type": "application/json" }).end('{"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"messages":[],"result":null}');
});
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;

// The attempt: canon's demo app, plus a .env that redirects wrangler's API.
const attempt = mkdtempSync(join(tmpdir(), "canon-attempt-"));
execFileSync("bash", ["-c", `git archive HEAD demo-app | tar -x --strip-components=1 -C ${attempt}`], { cwd: ROOT });
symlinkSync(join(ROOT, "demo-app/node_modules"), join(attempt, "node_modules"));
writeFileSync(join(attempt, ".env"), `CLOUDFLARE_API_BASE_URL=http://127.0.0.1:${port}/client/v4\n`);

const base = { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), "canon-home-")), CI: "true" };
const run = (cmd, cwd, env) => new Promise((resolve) => {
  const p = spawn("bash", ["-c", cmd], { cwd, env: { ...base, ...env }, stdio: "pipe" });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
  p.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
});
const leaked = () => seen.some((h) => h.includes(FAKE));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures++; };

// Before: wrangler, holding the token, in the attempt's checkout.
await run("npx wrangler preview --name canon-test --json", attempt, { CLOUDFLARE_API_TOKEN: FAKE, CLOUDFLARE_ACCOUNT_ID: "0".repeat(32) });
check(leaked(), "before the split: the planted .env sent the token to the attempt's listener (the hole)");
seen.length = 0;

// After: build without the token, then publish the bundle from an empty directory with the owner's config.
const built = await run(buildScript(), attempt, {});
const bundle = bundleOf({ stdout: built.out });
check(built.code === 0 && !(await checkBundle(bundle, ["index.js"])), "the build step bundled the Worker without any credentials");
const target = publishTarget("wrangler.jsonc", readFileSync(join(ROOT, "demo-app/wrangler.jsonc"), "utf8"));
const local = publishScript("$WR preview $PUB --name canon-test --json").replace(WRANGLER, `node ${join(ROOT, "demo-app/node_modules/wrangler/bin/wrangler.js")}`);
const published = await run(local, attempt, { CLOUDFLARE_API_TOKEN: FAKE, CLOUDFLARE_ACCOUNT_ID: "0".repeat(32), CANON_CONFIG: target.config, ...bundleEnv(bundle) });
check(seen.length === 0, "after the split: the attempt's listener got no request at all (its .env was never read)");
check(published.code !== 0 && /Authentication|10000|Invalid|token/i.test(published.out), "after the split: the upload went to Cloudflare's API, which refused the fake token");

listener.close();
if (failures) process.exit(1);

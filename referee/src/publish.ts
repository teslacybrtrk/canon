// The deploy token never shares a container with code an attempt controls, or with files it can write.
//
// BUILD, without credentials: in the attempt's checkout (its dependencies installed with install scripts off), wrangler
// bundles the Worker (`deploy --dry-run --outdir`) and the bundle comes back as one line of output,
// `CANON_BUNDLE <base64 of gzipped JSON {path: base64}>`. Whatever the repository does during a build (a build
// command, a .env, a redirected config) happens here, where there is no token to take.
//
// PUBLISH, with credentials: a fresh container restored from the same install (`npm ci --ignore-scripts` on canon's
// lockfile; an attempt can't change the lockfile or anything under node_modules, see Referee.buildGuard). In an empty
// directory outside the checkout it writes only the bundle the judge checked and the owner's Wrangler config (read by
// the judge from canon, its build fields dropped), and uploads them with that install's wrangler, `.env` loading off.
// No repository script or hook runs there, and no repository file is read.

/** Wrangler from the install snapshot, run by path (not npx, which would resolve from the working directory). */
export const WRANGLER = "node /workspace/node_modules/wrangler/bin/wrangler.js";

// The bundle is handed from the build step to the publish step inline: the build step's output stays inline up to
// 300 KB (the CI package's limit), and the publish step receives it in environment variables of at most 100 KB each
// (Linux refuses a single variable over 128 KB).
const BUNDLE_MAX = 280_000;
const CHUNK = 100_000;
const SAFE_PATH = /^[\w.-]+(\/[\w.-]+)*$/;

// Packs the build output: every file wrangler wrote except source maps and its READMEs, as gzipped JSON.
const PACK_JS = String.raw`const fs = require("fs"), path = require("path"), zlib = require("zlib");
const root = process.argv[2], files = {};
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p); else if (e.isFile() && !p.endsWith(".map") && e.name !== "README.md") files[path.relative(root, p)] = fs.readFileSync(p).toString("base64"); } };
walk(root);
console.log("CANON_BUNDLE " + zlib.gzipSync(JSON.stringify(files)).toString("base64"));`;

// Writes the bundle into ./bundle as regular files, refusing any path that could leave it.
const UNPACK_JS = String.raw`const fs = require("fs"), path = require("path"), zlib = require("zlib");
let b64 = "";
for (let i = 0; process.env["CANON_BUNDLE_" + i] !== undefined; i++) b64 += process.env["CANON_BUNDLE_" + i];
if (b64) for (const [p, body] of Object.entries(JSON.parse(zlib.gunzipSync(Buffer.from(b64, "base64"))))) {
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(p) || p.split("/").some((s) => s === "." || s === "..")) throw new Error("refused bundle path " + p);
  const to = path.join("bundle", p);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, Buffer.from(body, "base64"));
}`;

const b64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Prints the CANON_BUNDLE line for the build output in .canon-build. */
export const PACK = `printf %s ${b64(PACK_JS)} | base64 -d > /tmp/canon-pack.js && node /tmp/canon-pack.js .canon-build`;

/** The build step's script, in the attempt's checkout (or DIR). Prints the CANON_BUNDLE line. */
export const buildScript = (dir = ".") => [
  `set -e`,
  `cd ${dir}`,
  `rm -rf .canon-build`,
  `npx wrangler deploy --dry-run --outdir .canon-build > /tmp/canon-build.log 2>&1 || { tail -c 3000 /tmp/canon-build.log >&2; exit 1; }`,
  PACK,
].join("\n");

/** The build step for production's code (the rollback rehearsal, the candidate rebuild): a clone of PREV_URL at PREV_SHA. */
export const PREV_BUILD_SCRIPT = [
  `set -e`,
  `rm -rf /tmp/canon-prev && git clone -q "$PREV_URL" /tmp/canon-prev && cd /tmp/canon-prev && git checkout -q "$PREV_SHA"`,
  `npm ci --no-audit --no-fund --ignore-scripts >/dev/null`,
  buildScript("/tmp/canon-prev"),
].join("\n");

/**
 * The publish step's script: an empty directory with the bundle and the owner's config, then COMMANDS, which call
 * wrangler as `$WR` (or a wrapper around it) with `$PUB` (the config, and no .env files).
 */
export const publishScript = (commands: string) => [
  `set -e`,
  `rm -rf /tmp/canon-publish && mkdir -p /tmp/canon-publish && cd /tmp/canon-publish`,
  `printf %s "$CANON_CONFIG" | base64 -d > wrangler.json`,
  `printf %s ${b64(UNPACK_JS)} | base64 -d > /tmp/canon-unpack.js && node /tmp/canon-unpack.js`,
  `WR="${WRANGLER}"; PUB="--config /tmp/canon-publish/wrangler.json --env-file /dev/null"`,
  commands,
].join("\n");

/** The CANON_BUNDLE payload in a build step's output, or null. */
export function bundleOf(logs: { stdout?: unknown }): string | null {
  if (typeof logs.stdout !== "string") return null;
  const line = logs.stdout.split("\n").find((l) => l.startsWith("CANON_BUNDLE "));
  return line ? line.slice("CANON_BUNDLE ".length).trim() : null;
}

/** The bundle as the publish step's environment. */
export function bundleEnv(bundle: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (let i = 0; i * CHUNK < bundle.length; i++) env[`CANON_BUNDLE_${i}`] = bundle.slice(i * CHUNK, (i + 1) * CHUNK);
  return env;
}

/** Why the judge won't publish this bundle, or null: it must unpack, stay small, keep to plain paths and hold ENTRIES. */
export async function checkBundle(bundle: string | null, entries: string[]): Promise<string | null> {
  if (!bundle) return "the build printed no bundle (its output was too large, or the build didn't finish)";
  if (bundle.length > BUNDLE_MAX) return `its bundle is ${Math.round(bundle.length / 1000)} KB packed, over the ${BUNDLE_MAX / 1000} KB the judge hands to the publishing step (a limit of this prototype)`;
  let files: Record<string, unknown>;
  try {
    const bytes = Uint8Array.from(atob(bundle), (c) => c.charCodeAt(0));
    files = JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
  } catch {
    return "its build didn't produce a bundle the judge could read";
  }
  const paths = Object.keys(files ?? {});
  if (!paths.length || paths.length > 200) return `its bundle has ${paths.length} files`;
  const bad = paths.find((p) => !SAFE_PATH.test(p) || p.split("/").some((s) => s === "." || s === "..") || typeof files[p] !== "string");
  if (bad) return `its bundle has a file the judge won't publish: ${bad.slice(0, 80)}`;
  const missing = entries.find((e) => !paths.includes(e));
  return missing ? `its bundle has no ${missing}` : null;
}

/** JSON with comments and trailing commas (wrangler.jsonc). Throws when it isn't. */
export function parseJsonc(text: string): Record<string, unknown> {
  let out = "";
  for (let i = 0, inString = false; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') (inString = true), (out += c);
    else if (c === "/" && text[i + 1] === "/") while (i < text.length && text[i] !== "\n") i++;
    else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  const value = JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
  return value as Record<string, unknown>;
}

export type PublishTarget = { config: string; entry: string; objects: boolean } | { refused: string };

/**
 * The owner's Wrangler config, made to publish a bundle that's already built: the entry is the bundle's, nothing is
 * bundled again, and the build fields are gone (the build already ran, without credentials). Bindings, routes,
 * migrations and compatibility settings stay exactly as the owner wrote them.
 */
export function publishTarget(path: string, text: string): PublishTarget {
  if (path.endsWith(".toml")) return { refused: "the judge publishes from wrangler.jsonc or wrangler.json, and this project's config is wrangler.toml (a limit of this prototype)" };
  let c: Record<string, unknown>;
  try {
    c = parseJsonc(text);
  } catch {
    return { refused: `the judge couldn't parse ${path}` };
  }
  if (typeof c.main !== "string" || !c.main) return { refused: `${path} names no "main" entry point` };
  if (c.assets !== undefined || c.site !== undefined) return { refused: "the judge doesn't publish static assets yet (a limit of this prototype)" };
  const entry = `${c.main.split("/").pop()!.replace(/\.[^.]+$/, "")}.js`;
  for (const k of ["$schema", "build", "alias", "define", "tsconfig", "minify", "keep_names", "upload_source_maps", "find_additional_modules", "base_dir", "no_bundle"]) delete c[k];
  for (const e of Object.values((c.env ?? {}) as Record<string, Record<string, unknown>>)) if (e && typeof e === "object") delete e.build;
  Object.assign(c, { main: `bundle/${entry}`, no_bundle: true, find_additional_modules: true, base_dir: "bundle" });
  const objects = Array.isArray((c.durable_objects as { bindings?: unknown[] } | undefined)?.bindings) && (c.durable_objects as { bindings: unknown[] }).bindings.length > 0;
  return { config: b64(JSON.stringify(c, null, 2)), entry, objects };
}

/**
 * Paths only the owner changes, because they decide what installs or what deploys: the lockfile and .npmrc, the
 * Wrangler config (bindings, routes) with its redirect and state under .wrangler, files wrangler loads into its own
 * environment (.env, .dev.vars), and anything under node_modules (it would land on top of the installed toolchain the
 * publish step runs). Returns why PATH is one of them, or null.
 */
export function ownerPath(path: string): string | null {
  if (/(^|\/)node_modules(\/|$)/.test(path)) return `it adds or changes ${path}: files under node_modules would land on top of the installed toolchain the judge publishes with`;
  if (path === "package-lock.json" || /(^|\/)\.npmrc$/.test(path)) return `it changes ${path}: dependencies and how they install are canon's`;
  if (/^wrangler\.(jsonc|json|toml)$/.test(path) || /^\.wrangler(\/|$)/.test(path)) return `it changes ${path}: the deploy config (bindings, routes, build) is canon's`;
  if (/(^|\/)\.(env|dev\.vars)(\.[^/]*)?$/.test(path)) return `it adds or changes ${path}: wrangler loads it into its own environment`;
  return null;
}

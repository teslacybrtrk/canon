import type { Env } from "./env";

// canon.rodeo serves Canon's own source from Artifacts, and every attempt, read-only:
//   git clone https://canon.rodeo/canon.git               Canon's source (namespace canon-src)
//   git clone https://canon.rodeo/a/<attempt-id>.git        any attempt, including rejected ones
//   https://canon.rodeo/src                               browse Canon's source
// The Worker mints a short-lived read token per request; pushes are always refused.

const GITHUB_MIRROR = "https://github.com/teslacybrtrk/canon";
const SOURCE_REPO = "canon";
const READ_TOKEN_TTL_S = 300;

export async function serveGit(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/(?:(canon)|(?:a|w)\/([\w.-]+))\.git(\/.*)$/);
  if (!m) return null;
  const [, isSource, attempt, rest] = m;
  if (isSource && env.SOURCE_PUBLIC !== "true") return new Response("not found\n", { status: 404 });
  if (rest.includes("git-receive-pack") || url.searchParams.get("service") === "git-receive-pack") {
    return new Response("canon.rodeo is read-only: push to your own attempt's remote instead.\n", { status: 403 });
  }
  if (!(rest === "/info/refs" || rest === "/git-upload-pack")) return new Response("not found\n", { status: 404 });

  const ns = isSource ? env.SOURCE : env.ARTIFACTS;
  let remote: string;
  let token: string;
  try {
    using repo = await ns.get(isSource ? SOURCE_REPO : attempt);
    remote = (await repo.info()).remote;
    token = (await repo.createToken("read", READ_TOKEN_TTL_S)).plaintext.split("?expires=")[0];
  } catch {
    return new Response("no such repository\n", { status: 404 });
  }

  const headers = new Headers({ authorization: `Bearer ${token}` });
  for (const h of ["content-type", "accept", "git-protocol", "content-encoding"]) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  const upstream = await fetch(`${remote}${rest}${url.search}`, {
    method: request.method,
    headers,
    body: request.method === "POST" ? request.body : undefined,
  });
  const out = new Headers();
  for (const h of ["content-type", "cache-control", "content-encoding"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export async function serveSource(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/src" && !url.pathname.startsWith("/src/")) return null;
  if (env.SOURCE_PUBLIC !== "true") return page("Canon source", "<p>The source will be published here on submission day.</p>", 404);
  const path = decodeURIComponent(url.pathname.slice("/src".length)).replace(/^\/+|\/+$/g, "");

  using repo = await env.SOURCE.get(SOURCE_REPO);
  const [head] = await repo.log({ ref: "main", limit: 1 });
  if (!head) return page("Canon source", "<p>The source repo is empty.</p>", 404);

  // Walk the tree to the requested path.
  let tree = await repo.readTree(head.treeHash);
  const parts = path ? path.split("/") : [];
  for (const [i, part] of parts.entries()) {
    const entry = tree?.find((e) => e.name === part);
    if (!entry) return page("Not found", `<p>No ${esc(path)} in Canon's source.</p>`, 404);
    if (entry.type === "tree") {
      tree = await repo.readTree(entry.hash);
      continue;
    }
    if (i !== parts.length - 1) return page("Not found", `<p>No ${esc(path)} in Canon's source.</p>`, 404);
    const blob = await repo.readBlob(entry.hash);
    const text = blob ? await blob.text() : "";
    return page(path, `${crumbs(parts)}<pre><code>${esc(text)}</code></pre>`);
  }

  const rows = (tree ?? [])
    .slice()
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1))
    .map((e) => {
      const href = `/src/${[...parts, e.name].map(encodeURIComponent).join("/")}`;
      return `<li><a href="${href}">${esc(e.name)}${e.type === "tree" ? "/" : ""}</a></li>`;
    })
    .join("");
  const intro = path
    ? ""
    : `<p>Canon's own source, served from Cloudflare Artifacts by Canon's referee Worker.
        Latest commit <code>${head.hash.slice(0, 8)}</code>: ${esc(head.message.split("\n")[0])}.</p>
       <pre><code>git clone https://canon.rodeo/canon.git</code></pre>
       <p>Every attempt can be cloned the same way, including rejected ones: <code>git clone https://canon.rodeo/a/&lt;attempt-id&gt;.git</code>.
        Mirror: <a href="${GITHUB_MIRROR}">${GITHUB_MIRROR}</a>. License: MIT.</p>`;
  return page(path || "Canon source", `${intro}${crumbs(parts)}<ul class="tree">${rows}</ul>`);
}

function crumbs(parts: string[]) {
  const links = [`<a href="/src">canon</a>`];
  parts.forEach((p, i) => links.push(`<a href="/src/${parts.slice(0, i + 1).map(encodeURIComponent).join("/")}">${esc(p)}</a>`));
  return `<nav>${links.join(" / ")}</nav>`;
}

function page(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Canon</title>
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<style>
  :root { --bg:#fbf7f2; --panel:#fff; --ink:#01132a; --muted:#5b6577; --line:#e7e1d8; --accent:#c2410c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#010e20; --panel:#06182f; --ink:#f3eee6; --muted:#93a1b5; --line:#16304f; --accent:#fd8a3d; } }
  * { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 ui-sans-serif,system-ui,sans-serif }
  main { max-width:960px; margin:0 auto; padding:20px 16px 40px } h1 { font-size:22px; margin:0 0 8px }
  a { color:var(--accent) } nav { margin:12px 0; color:var(--muted) } code, pre { font:13px/1.5 ui-monospace,monospace }
  pre { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; overflow-x:auto }
  .tree { list-style:none; padding:0; margin:0; background:var(--panel); border:1px solid var(--line); border-radius:8px }
  .tree li { padding:6px 12px; border-top:1px solid var(--line) } .tree li:first-child { border-top:0 }
</style></head><body><main><h1><a href="/" style="color:inherit;text-decoration:none">Canon</a> · source</h1>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

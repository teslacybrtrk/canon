import type { Env } from "./env";
import { errorStatus, type CanonState, type DeclareRequest, type FactDef, type Verdict } from "./protocol";
import { globToRegExp } from "./scope";
import { refereeForProject } from "./stub";

// Canon over MCP: the moves as tools any MCP agent can call, at /p/<project>/mcp (Streamable HTTP, JSON
// responses, no sessions). Git stays in the agent's own shell: claiming returns the commands that clone the
// attempt and record the claim, and the agent pushes with plain Git as always.

type Referee = ReturnType<typeof refereeForProject>;
type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
type Args = Record<string, unknown>;

const PROTOCOL_VERSION = "2025-06-18";

const INSTRUCTIONS = `Canon: main is not a branch, it is the set of facts that must stay true. A fact is a sentence plus a check
the judge runs on a live preview of every commit. To change the app: canon_read to see the facts and what other
agents are doing; canon_claim the one fact you will make true (you get your own attempt: a fork with its own Git
remote, and the shell commands to start in it); make the change and git push; then canon_verdict. Never edit a
fact's check to make it pass, and never edit canon.json yourself. If a canon fact must change on purpose, claim a
revision: a fact with "replaces": "<fact id>". A person accepts facts; you never accept your own.`;

const TOOLS = [
  {
    name: "canon_read",
    description: "Read canon: the facts that must stay true (with their checks), the backlog of facts people want, and what every agent is trying to make true right now. Pass `path` to see only the facts that govern that file.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "A file path, e.g. src/index.ts" } } },
  },
  {
    name: "canon_claim",
    description: "Claim the one new fact you will make true, or join a fact someone proposed (a backlog fact). Returns your attempt (a fork only you can push to) and the exact shell commands to clone it and record the claim.",
    inputSchema: {
      type: "object",
      required: ["agent", "why"],
      properties: {
        agent: { type: "string", description: "Your name on the board, e.g. agent-3" },
        why: { type: "string", description: "One sentence: why this fact matters. It is kept in the fact's history." },
        fact: { type: "object", description: 'A new fact: {"id": "slug", "sentence": "...", "check": {...}}. Add "replaces": "<fact id>" to revise a canon fact on purpose.' },
        join: { type: "string", description: "The id of a proposed or backlog fact to make true instead of proposing your own" },
      },
    },
  },
  {
    name: "canon_verdict",
    description: "What the judge found for your attempt: facts kept, facts broken (with why), and whether your fact holds. Pass the commit you pushed (git rev-parse HEAD) and wait=true to wait for its verdict.",
    inputSchema: {
      type: "object",
      required: ["attempt"],
      properties: {
        attempt: { type: "string", description: "Your attempt id, from canon_claim" },
        sha: { type: "string", description: "The commit you pushed" },
        wait: { type: "boolean", description: "Wait up to about 45 seconds for the verdict of that commit" },
      },
    },
  },
  {
    name: "canon_refresh",
    description: "Your attempt is BEHIND (canon moved after you forked). Makes you a fresh attempt from the current canon for the same fact, and returns the commands that replay your changes onto it.",
    inputSchema: {
      type: "object",
      required: ["attempt", "agent"],
      properties: { attempt: { type: "string", description: "The attempt that is behind" }, agent: { type: "string" } },
    },
  },
  {
    name: "canon_why",
    description: "Why a fact is true: the attempt and reason that made it true, and every attempt that failed it, with the exact reason.",
    inputSchema: { type: "object", required: ["fact"], properties: { fact: { type: "string", description: "A fact id" } } },
  },
];

export async function serveMcp(request: Request, env: Env, project: string): Promise<Response> {
  if (request.method !== "POST") return new Response("Canon's MCP endpoint takes JSON-RPC over POST.", { status: 405, headers: { allow: "POST" } });
  let body: Rpc | Rpc[];
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "parse error"), { status: 400 });
  }
  const referee = refereeForProject(env, project);
  const messages = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(messages.map((m) => handle(m, referee, project)))).filter((r) => r !== null);
  if (replies.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? replies : replies[0]);
}

async function handle(m: Rpc, referee: Referee, project: string) {
  if (m.id === undefined || m.id === null) return null; // a notification, e.g. notifications/initialized
  switch (m.method) {
    case "initialize": {
      const asked = typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : PROTOCOL_VERSION;
      return ok(m.id, { protocolVersion: asked, capabilities: { tools: {} }, serverInfo: { name: `canon-${project}`, version: "1.0.0" }, instructions: INSTRUCTIONS });
    }
    case "ping":
      return ok(m.id, {});
    case "tools/list":
      return ok(m.id, { tools: TOOLS });
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      const args = (m.params?.arguments ?? {}) as Args;
      try {
        const text = await call(name, args, referee, project);
        return ok(m.id, { content: [{ type: "text", text }] });
      } catch (err) {
        return ok(m.id, { content: [{ type: "text", text: errorStatus(err).message }], isError: true });
      }
    }
    default:
      return rpcError(m.id, -32601, `unknown method ${m.method}`);
  }
}

async function call(name: string, args: Args, referee: Referee, project: string): Promise<string> {
  const str = (key: string) => (typeof args[key] === "string" && args[key] ? (args[key] as string) : null);
  const need = (key: string) => str(key) ?? fail(`"${key}" is required`);
  if (name === "canon_read") return read((await referee.read()) as CanonState, str("path"));
  if (name === "canon_why") return why((await referee.why(need("fact"))) as unknown as FactChain);
  if (name === "canon_verdict") return verdict(referee, need("attempt"), str("sha"), args.wait === true);
  if (name === "canon_claim") {
    const req = { agent: need("agent"), why: need("why") } as DeclareRequest;
    if (str("join")) Object.assign(req, { join: str("join") });
    else if (args.fact && typeof args.fact === "object") Object.assign(req, { fact: args.fact as FactDef });
    else fail('pass "fact" (a new fact or a revision) or "join" (a fact id)');
    const declared = await referee.declare(req);
    return start(referee, project, declared.claim, declared.attempt, req.agent, null);
  }
  if (name === "canon_refresh") {
    const state = (await referee.read()) as CanonState;
    const old = state.claims.find((c) => c.attemptId === need("attempt"));
    if (!old) fail(`no claim for attempt "${args.attempt}"`);
    if (old!.status === "superseded") fail(`attempt ${old!.attemptId} was already refreshed or replaced; call canon_verdict on it to find the newer attempt`);
    if (old!.verdict?.outcome !== "behind") fail(`refresh is only for an attempt that is BEHIND; this one is ${old!.verdict?.outcome ?? old!.status}`);
    const declared = await referee.declare({ agent: need("agent"), why: `${old!.why} (refreshed onto canon ${state.canon?.seq})`, join: old!.factId, replaces: old!.id });
    return start(referee, project, declared.claim, declared.attempt, need("agent"), old!.attemptId);
  }
  return fail(`unknown tool ${name}`);
}

// The commands that clone a new attempt and record the claim, plus (on refresh) replay the old attempt's changes.
async function start(referee: Referee, project: string, claim: { id: string; factId: string }, attempt: { id: string; remote: string; token: string }, agent: string, from: string | null) {
  const ledger = await referee.attemptLedger(attempt.id);
  const remote = new URL(attempt.remote);
  remote.username = "x";
  remote.password = attempt.token;
  const trailers = `--trailer "Canon-Fact: ${claim.factId}" --trailer "Canon-Claim: ${claim.id}" --trailer "Canon-Agent: ${agent}"`;
  const replay = from
    ? [
        `# In your old attempt (${from}), save your changes since its claim commit:`,
        `#   git diff --binary "$(git log --format=%H --grep='^canon: claim' -n 1)"..HEAD -- . ':(exclude)canon.json' > ../${from}.patch`,
        `# Then, in the new attempt, after the commands below:`,
        `#   git apply --3way ../${from}.patch   (resolve any conflict markers, keeping canon's code and yours)`,
        `#   git commit -am "Re-apply ${from} on the current canon" ${trailers}`,
        ``,
      ]
    : [];
  return [
    `Claim ${claim.id}: ${agent} is trying to make "${claim.factId}" true on ${project}.`,
    `Your attempt: ${attempt.id}, a fork only you can push to. Its token is in the clone URL below.`,
    ``,
    ...replay,
    `Run these to start:`,
    "```sh",
    `git clone ${remote} ${attempt.id} && cd ${attempt.id}`,
    `git config user.name "${agent}" && git config user.email "${agent}@canon.local"`,
    `cat > canon.json <<'CANON_JSON'`,
    ledger.trimEnd(),
    `CANON_JSON`,
    `git commit -qam 'canon: claim "${claim.factId}"' ${trailers}`,
    "```",
    `Then make the change, commit (add the same --trailer flags), \`git push origin main\`, and call canon_verdict with attempt "${attempt.id}" and the commit you pushed.`,
    `Don't edit canon.json again: the judge rejects an attempt whose canon.json is anything but canon plus your fact.`,
  ].join("\n");
}

function read(s: CanonState, path: string | null): string {
  if (!s.canon) return "No canon yet: genesis has not passed its seed facts.";
  const governs = (f: { scope: string[] | null }) => !path || !f.scope || f.scope.some((g) => globToRegExp(g).test(path.replace(/^\.\//, "")));
  const facts = s.facts.filter(governs);
  const line = (f: CanonState["facts"][number]) => `- ${f.id}: ${f.sentence}${f.scope ? ` [only when ${f.scope.join(", ")} change]` : ""}\n  check: ${JSON.stringify(f.check)}`;
  const out = [`Canon of ${s.project}: attempt ${s.canon.attemptId} @ ${s.canon.sha.slice(0, 8)} (#${s.canon.seq})${s.policy.autoAccept === "backlog" ? ". Autopilot: an attempt that makes a backlog fact true lands on its own." : ""}`];
  if (path) out.push(`(only the facts that govern ${path})`);
  out.push("", "FACTS THAT MUST STAY TRUE", ...facts.filter((f) => f.status === "canon").map(line));
  const backlog = facts.filter((f) => f.status === "proposed" && f.origin === "backlog");
  if (backlog.length) out.push("", "BACKLOG (written by people; claim one with join)", ...backlog.map(line));
  const proposed = facts.filter((f) => f.status === "proposed" && f.origin !== "backlog");
  if (proposed.length) out.push("", "PROPOSED BY AGENTS", ...proposed.map(line));
  const live = s.claims.filter((c) => !["accepted", "superseded"].includes(c.status));
  if (live.length) out.push("", "CLAIMS IN FLIGHT", ...live.map((c) => `- ${c.agent} is trying to make "${c.sentence}" true [${c.status}] (attempt ${c.attemptId})`));
  return out.join("\n");
}

async function verdict(referee: Referee, attempt: string, sha: string | null, wait: boolean): Promise<string> {
  const deadline = Date.now() + (wait ? 45_000 : 0);
  let v: Verdict | null;
  for (;;) {
    v = (await referee.verdict(attempt)) as Verdict | null;
    if ((v && (!sha || v.sha.startsWith(sha) || sha.startsWith(v.sha))) || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  // Canon moved and the judge re-applied this attempt on the current canon: report the newer attempt instead.
  const moved: string[] = [];
  for (let hops = 0; v?.refreshedAs && hops < 5; hops++) {
    moved.push(`Canon moved after ${v.attemptId} forked; the judge re-applied your change on the current canon as attempt ${v.refreshedAs}.`);
    const next = (await referee.verdict(v.refreshedAs)) as Verdict | null;
    if (!next) return [...moved, `Its preview is still building. Call canon_verdict with attempt "${v.refreshedAs}" in a minute.`].join("\n");
    v = next;
    sha = null;
  }
  if (!v || (sha && !v.sha.startsWith(sha) && !sha.startsWith(v.sha))) {
    return `No verdict${sha ? ` for ${sha.slice(0, 8)}` : ""} yet: the preview is still building (about a minute after a push), or the commit isn't pushed. Call canon_verdict again.`;
  }
  const out = [...moved, `VERDICT ${v.outcome.toUpperCase()}: attempt ${v.attemptId} @ ${v.sha.slice(0, 8)}`];
  if (v.outcome === "error") return [...out, v.claimed.detail, "This is not about your code. Push again (an empty commit is fine), then call canon_verdict."].join("\n");
  if (v.previewUrl) out.push(`preview ${v.previewUrl}`);
  for (const id of v.kept) out.push(`  kept     ${id}`);
  for (const l of v.lost) out.push(`  LOST     ${l.factId}: ${l.detail}`);
  for (const l of v.stale ?? []) out.push(`  NEWER    ${l.factId} became canon after you forked: ${l.detail}`);
  for (const id of v.retires ?? []) out.push(`  RETIRES  ${id} (your claim revises this rule on purpose; a person decides)`);
  out.push(`  claimed  ${v.claimed.factId}: ${v.claimed.held ? "holds" : v.claimed.detail}`);
  for (const c of v.clashes ?? []) {
    out.push(c.breaks === "mine" ? `  CLASH    ${c.with.agent}'s attempt ${c.with.attemptId} breaks your fact: ${c.detail}` : `  CLASH    your attempt breaks ${c.with.agent}'s fact ${c.factId}: ${c.detail}`);
  }
  const conflict = v.outcome === "behind" && ((await referee.read()) as CanonState).claims.find((c) => c.attemptId === v.attemptId)?.refresh?.startsWith("conflict");
  const next = {
    ready: `Ready. Stop here: a person decides whether "${v.claimed.factId}" becomes canon.`,
    contradicts: "This attempt contradicts canon. Make the lost facts hold again and push. To change one of them on purpose, claim a revision instead (a fact with \"replaces\").",
    unproven: "Canon held, but your fact doesn't hold yet. Fix it and push again.",
    behind: conflict
      ? "Canon moved after this attempt forked, and your change conflicts with the new canon's code. Call canon_refresh, then resolve the conflict."
      : "Canon moved after this attempt forked. The judge re-applies your change on the current canon by itself; call canon_verdict again in a minute.",
  }[v.outcome as string];
  if (next) out.push("", next);
  return out.join("\n");
}

// The parts of the referee's fact chain this text uses.
interface FactChain {
  fact: { id: string; status: string; sentence: string };
  madeTrueBy: { attempt: { id: string } | null; claim: { agent: string; why: string } | null } | null;
  replaces: { id: string; sentence: string } | null;
  retiredBy: { claim: { agent: string; why: string } | null } | null;
  rejected: Array<{ attempt_id: string; agent: string | null; kind: string; detail: string }>;
}

function why(w: FactChain): string {
  const out = [`${w.fact.id} [${w.fact.status}]: ${w.fact.sentence}`];
  if (w.madeTrueBy?.attempt) out.push(`made true by attempt ${w.madeTrueBy.attempt.id} (${w.madeTrueBy.claim?.agent ?? "genesis"}: ${w.madeTrueBy.claim?.why ?? "a seed fact"})`);
  if (w.replaces) out.push(`revises ${w.replaces.id}: ${w.replaces.sentence}`);
  if (w.retiredBy) out.push(`retired by ${w.retiredBy.claim?.agent}: ${w.retiredBy.claim?.why}`);
  const failed = w.rejected.slice(0, 8);
  if (failed.length) out.push("", "ATTEMPTS THAT FAILED IT", ...failed.map((r) => `- ${r.attempt_id} (${r.agent ?? "genesis"}, ${r.kind}): ${r.detail}`));
  return out.join("\n");
}

function ok(id: Rpc["id"], result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: Rpc["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function fail(message: string): never {
  throw new Error(message);
}

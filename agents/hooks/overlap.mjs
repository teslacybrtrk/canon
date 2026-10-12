#!/usr/bin/env node
// A Claude Code PostToolUse hook: after an agent edits a file inside a Canon attempt, ask the judge who else in flight
// is changing the same files (`canon overlap`) and put the answer in front of the agent, so it hears about overlapping
// work while it is still editing, without having to remember to ask. It speaks only when the list changes.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;
let event;
try {
  event = JSON.parse(input);
} catch {
  process.exit(0);
}
const file = event?.tool_input?.file_path;
if (!file) process.exit(0);

// The attempt this file belongs to: the nearest folder with .git/canon.json (written by `canon claim`).
let dir = dirname(resolve(event.cwd ?? process.cwd(), file));
while (!existsSync(join(dir, ".git", "canon.json"))) {
  const up = dirname(dir);
  if (up === dir) process.exit(0);
  dir = up;
}

const cli = join(dirname(new URL(import.meta.url).pathname), "..", "..", "cli", "canon.mjs");
let out = "";
try {
  out = execFileSync("node", [cli, "overlap"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).toString().trim();
} catch {
  process.exit(0); // the judge unreachable: say nothing rather than block the edit
}
// Only the same code is worth interrupting for: another agent changing a function this edit touches.
if (!out.startsWith("Others changing the same code")) process.exit(0);

// Only a change in who overlaps is news.
const last = join(dir, ".git", "canon-overlap-last");
if (existsSync(last) && readFileSync(last, "utf8") === out) process.exit(0);
writeFileSync(last, out);
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `Canon: ${out}` } }));

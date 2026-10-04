#!/usr/bin/env node
// Summarise an agent transcript (claude -p --output-format stream-json):
//   node scripts/agent-log.mjs runs/agent-4-sold-out/agent.log
import { readFileSync } from "node:fs";

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s).replace(/\s+/g, " ");
for (const line of readFileSync(process.argv[2], "utf8").split("\n")) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  if (e.type === "assistant") {
    for (const c of e.message.content) {
      if (c.type === "text") console.log(`SAY   ${clip(c.text, 300)}`);
      if (c.type === "tool_use") console.log(`TOOL  ${c.name} ${clip(JSON.stringify(c.input), 200)}`);
    }
  } else if (e.type === "user") {
    for (const c of e.message.content ?? []) {
      if (c?.type !== "tool_result") continue;
      const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
      console.log(`  ${c.is_error ? "ERR" : "->"}  ${clip(text, 240)}`);
    }
  } else if (e.type === "result") {
    console.log(`RESULT ${e.subtype} turns=${e.num_turns} ${Math.round((e.duration_ms ?? 0) / 1000)}s cost=$${(e.total_cost_usd ?? 0).toFixed(3)}`);
    console.log(clip(String(e.result ?? ""), 600));
  }
}

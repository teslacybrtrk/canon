// Production telemetry for a gradual rollout: real traffic per Worker version, from Cloudflare's GraphQL analytics
// (workersInvocationsAdaptive, by scriptVersion). Best effort: when the API or the token's permissions don't allow it,
// it says why, and the canary stands on its own synthetic traffic alone (see Referee.canaryWatch).

export type VersionTraffic = Record<string, { requests: number; errors: number }>;

export async function versionTraffic(accountId: string, token: string, script: string, since: string): Promise<{ ok: true; traffic: VersionTraffic } | { ok: false; why: string }> {
  const query = `query($account: string!, $script: string!, $since: Time!) {
    viewer { accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(limit: 50, filter: { scriptName: $script, datetime_geq: $since }) {
        sum { requests errors }
        dimensions { scriptVersion }
      }
    } }
  }`;
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { account: accountId, script, since } }),
    });
    const body = await res.json<{ data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{ sum: { requests: number; errors: number }; dimensions: { scriptVersion: string } }> }> } }; errors?: Array<{ message: string }> }>();
    if (body.errors?.length) return { ok: false, why: body.errors[0].message.slice(0, 160) };
    const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
    if (!rows) return { ok: false, why: `no analytics in the answer (${res.status})` };
    const traffic: VersionTraffic = {};
    for (const r of rows) {
      const t = (traffic[r.dimensions.scriptVersion] ??= { requests: 0, errors: 0 });
      t.requests += r.sum.requests;
      t.errors += r.sum.errors;
    }
    return { ok: true, traffic };
  } catch (err) {
    return { ok: false, why: String(err instanceof Error ? err.message : err).slice(0, 160) };
  }
}

/** A canary step's verdict from what it saw: bad when the new version fails where the old one, at the same moment and
 * with the same inputs, doesn't (twice), or when its real-traffic error rate is clearly above the old one's. */
export function canaryVerdict(s: { newFails: number; oldFails: number; mixedFails?: number; raw?: { newErrors: number; oldErrors: number; each: number }; analytics?: { newRate: number; oldRate: number; newRequests: number } }): { bad: boolean; why: string } {
  if (s.newFails >= 2 && s.newFails > s.oldFails) return { bad: true, why: `the new version failed ${s.newFails} checks the old one passed at the same moment` };
  // Mixed versions: a protected fact failing on routed traffic while each version, pinned, passes it at the same moment
  // (requests of one check landing on different versions disagree). Each version alone is fine; together they aren't.
  if ((s.mixedFails ?? 0) >= 2) return { bad: true, why: `routed traffic failed ${s.mixedFails} checks of existing facts that each version passed on its own: the two versions don't work together` };
  // Raw requests, no retries: an error rate the checks' own retries would hide (a request in three failing).
  const r = s.raw;
  if (r && r.each >= 20 && (r.newErrors - r.oldErrors) / r.each > 0.05) return { bad: true, why: `raw requests: ${r.newErrors} of ${r.each} failed on the new version against ${r.oldErrors} of ${r.each} on the old` };
  const a = s.analytics;
  if (a && a.newRequests >= 20 && a.newRate > a.oldRate + 0.02) return { bad: true, why: `real traffic: ${(a.newRate * 100).toFixed(1)}% errors on the new version against ${(a.oldRate * 100).toFixed(1)}% on the old` };
  if (s.mixedFails === 1) return { bad: false, why: "one routed failure that each version passed alone, not repeated in the step (recorded)" };
  return { bad: false, why: s.newFails ? `one isolated failure on the new version (${s.oldFails} on the old)` : "no failures" };
}

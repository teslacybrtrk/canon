// Telling the platform failing from the code failing. A build that dies because Cloudflare's API answered with an
// error page, or the network dropped, says nothing about the attempt: it must never count as breaking a fact.

const PLATFORM = [
  /received a malformed response from the api/i,
  /<!doctype html/i,
  /\b(500 internal server error|502 bad gateway|503 service unavailable|504 gateway time-?out)\b/i,
  /\b(econnreset|etimedout|eai_again|econnrefused|socket hang up|fetch failed)\b/i,
  /\b(429|too many requests|rate limit(ed)?)\b/i,
  /an unknown error occurred/i,
  /capacity (temporarily )?exceeded/i,
];

/** Whether a failed build's output shows the platform failing rather than the code. */
export function platformFailure(detail: string): boolean {
  return PLATFORM.some((p) => p.test(detail));
}

/**
 * Whether a failed check never reached the app: Cloudflare's edge answered for it (520-530, e.g. 530 for a hostname
 * that isn't routed) or the request got no answer at all. The app's own 500 is the code; these are not.
 */
export function edgeFailure(detail: string): boolean {
  return /returned 5(2\d|30)\b/.test(detail) || / failed: /.test(detail);
}

/** Failure classification and retry/fallback policy for a turn. Pure functions. */

export type FailureKind = "no_agent" | "tools_unreachable" | "auth" | "unreachable" | "rate_limit" | "server" | "model" | "harness_down" | "bad_request" | "unknown";

export interface Failure {
  kind: FailureKind;
  /** Short human-readable reason, safe to show (no secrets, no stack trace). */
  reason: string;
  /** Worth retrying the same model after a pause. */
  retryable: boolean;
  /** A different model might succeed. */
  fallbackable: boolean;
}

/** Strip anything that looks like a credential and keep one readable line. */
export function sanitize(message: string): string {
  return String(message ?? "")
    .replace(/(sk|gsk|pk|key|tok)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [redacted]")
    .replace(/\s+at\s+\S+\s+\(.*?\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** How to start TrueForge so it may call the editor's tool server on loopback. Shown whenever TrueForge is unreachable. */
export const START_HINT = `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@0.185.1 (PowerShell: set $env:OUTBOUND_URL_ALLOWED_HOSTS first; see the README)`;

export function classifyFailure(input: { message?: string; status?: number; harnessUnreachable?: boolean }): Failure {
  const msg = sanitize(input.message ?? "");
  const m = msg.toLowerCase();
  const status = input.status;
  if (input.harnessUnreachable) {
    return { kind: "harness_down", reason: `TrueForge is not reachable. Start it with: ${START_HINT}, and check the cIAo Forge URL setting.`, retryable: false, fallbackable: false };
  }
  if (status === 401 || status === 403 || /invalid[ _]api[ _]key|incorrect api key|unauthori[sz]ed|authentication|permission denied|invalid x-api-key|\b401\b|\b403\b/.test(m)) {
    return { kind: "auth", reason: `the model provider rejected the credentials (${msg || "401"})`, retryable: false, fallbackable: true };
  }
  if (status === 429 || /rate limit|too many requests|quota|\b429\b/.test(m)) {
    return { kind: "rate_limit", reason: `the model provider is rate limiting (${msg || "429"})`, retryable: true, fallbackable: true };
  }
  if (/econnrefused|enotfound|eai_again|etimedout|econnreset|fetch failed|cannot connect|network|socket hang up|unreachable|timed? ?out|connection (error|refused|closed)|getaddrinfo|dns/.test(m)) {
    return { kind: "unreachable", reason: `the model endpoint is unreachable (${msg})`, retryable: true, fallbackable: true };
  }
  if ((status !== undefined && status >= 500) || /\b50[0-4]\b|internal server error|bad gateway|service unavailable|overloaded/.test(m)) {
    return { kind: "server", reason: `the model provider returned a server error (${msg || status})`, retryable: true, fallbackable: true };
  }
  if (/model .*not (found|exist|configured)|unknown model|no such model|does not exist|not available|provider .*not/.test(m)) {
    return { kind: "model", reason: `the configured model is not available (${msg})`, retryable: false, fallbackable: true };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return { kind: "bad_request", reason: msg || `request rejected (${status})`, retryable: false, fallbackable: true };
  }
  return { kind: "unknown", reason: msg || "the model call failed", retryable: true, fallbackable: true };
}

/** Exponential backoff with a cap: 400 ms, 800 ms, 1600 ms… */
export function backoffMs(attempt: number, base = 400, cap = 4000): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempt));
}

export type NextStep = { action: "retry"; delayMs: number } | { action: "fallback" } | { action: "fail" };

/**
 * Decide what to do after a failed attempt.
 * Edits already applied in this turn make a silent re-run unsafe, so we stop.
 */
export function nextStep(f: Failure, s: { attemptOnThisAgent: number; maxRetries: number; onFallback: boolean; hasFallback: boolean; appliedEdits: number }): NextStep {
  if (f.kind === "harness_down") return { action: "fail" };
  if (s.appliedEdits > 0) return { action: "fail" };
  if (f.retryable && s.attemptOnThisAgent < s.maxRetries) return { action: "retry", delayMs: backoffMs(s.attemptOnThisAgent) };
  if (f.fallbackable && !s.onFallback && s.hasFallback) return { action: "fallback" };
  return { action: "fail" };
}

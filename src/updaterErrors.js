// electron-updater puts the whole releases feed (dozens of XML lines) into the
// error message when it cannot parse a response. This keeps the log readable and
// tells a flaky connection apart from a real update problem.

const TRANSIENT_CODES = [
  "ERR_NETWORK_CHANGED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_TIMED_OUT",
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_TUNNEL_CONNECTION_FAILED",
  "ERR_NETWORK_ACCESS_DENIED",
  "ERR_ADDRESS_UNREACHABLE",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
];

const MAX_LENGTH = 300;

const CODE_RE = /\b(?:net::)?(ERR_[A-Z_]+|E[A-Z]{4,}[A-Z_]*)\b/;

// The code is in the first line; the feed dump comes after it, so look there
// first and only then in the rest of the message.
export function networkErrorCode(err) {
  const text = String(err?.message ?? err ?? "");
  const match = CODE_RE.exec(text.split(/\r?\n/, 1)[0]) || CODE_RE.exec(text.slice(0, 2000));
  return match ? match[1] : null;
}

export function isTransientNetworkError(err) {
  const code = networkErrorCode(err);
  return !!code && TRANSIENT_CODES.includes(code);
}

// One short line for the log and the UI: the first line of the message, with
// the network error code appended when it was cut off from it.
export function summarizeUpdaterError(err) {
  const text = String(err?.message ?? err ?? "").trim();
  const firstLine = text.split(/\r?\n/, 1)[0];
  const code = networkErrorCode(err);
  let summary = firstLine.length > MAX_LENGTH ? `${firstLine.slice(0, MAX_LENGTH)}…` : firstLine;
  if (code && !summary.includes(code)) summary += ` [${code}]`;
  return summary || "unknown updater error";
}

// Retry plan for a transient failure: a few quiet attempts, then give up.
export const RETRY_DELAY_MS = 45_000;
export const MAX_RETRIES = 3;

export function createRetryPolicy({ delayMs = RETRY_DELAY_MS, maxRetries = MAX_RETRIES } = {}) {
  let attempts = 0;
  return {
    // Returns the delay before the next attempt, or null when it should not retry.
    next(err) {
      if (!isTransientNetworkError(err) || attempts >= maxRetries) return null;
      attempts += 1;
      return delayMs;
    },
    reset() {
      attempts = 0;
    },
    get attempts() {
      return attempts;
    },
  };
}

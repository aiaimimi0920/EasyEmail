export const M2U_DEFAULT_API_BASE = "https://api.m2u.io";
export const M2U_BROWSER_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
] as const;
export const M2U_DEFAULT_USER_AGENT = M2U_BROWSER_USER_AGENTS[0];
export const M2U_DEFAULT_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9";
export const M2U_DEFAULT_ACCEPT_ENCODING = "identity";
export const M2U_DEFAULT_PROBE_MAILBOX_SMOKE_INTERVAL_SECONDS = 900;
export const M2U_DOMAIN_MATCH_CONFIDENCE_TARGET = 0.97;
export const M2U_DOMAIN_MATCH_MAX_ATTEMPTS = 20;
export const M2U_DEFAULT_PROXY_MAX_ATTEMPTS = 10;
export const M2U_DEFAULT_PROXY_HELPER_TIMEOUT_MS = 45_000;
export const M2U_DEFAULT_PROXY_HOST_ID = "easy-email-service:m2u";
export const TRANSIENT_ERROR_RE = /(fetch failed|timeout|timed out|econnreset|socket hang up|network|status 5\d{2})/i;
export const CAPACITY_ERROR_RE = /(status 429|too many requests|rate limit|quota|daily_limit_exceeded|rate_limited)/i;
export const M2U_PROXY_FALLBACK_PATHS = new Set<string>([
  "/v1/domains",
  "/v1/mailboxes/auto",
  "/v1/mailboxes/custom",
]);

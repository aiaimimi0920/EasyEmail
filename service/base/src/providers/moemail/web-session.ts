import { buildStatusError } from "./failure.js";
import { MoemailClientError, type MoemailConfig } from "./types.js";

declare const fetch: (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export async function deleteMailboxViaWebSession(
  config: MoemailConfig,
  emailId: string,
): Promise<{ released: boolean; detail: string }> {
  const sessionToken = config.webSessionToken?.trim();
  if (!sessionToken) {
    throw new MoemailClientError("MoEmail web session token is missing.", "provider");
  }

  const origin = trimTrailingSlash(config.apiBase || "https://sall.cc");
  const cookieParts = [
    `__Secure-authjs.session-token=${sessionToken}`,
    config.webCsrfToken?.trim()
      ? `__Host-authjs.csrf-token=${config.webCsrfToken.trim()}`
      : undefined,
    config.webCallbackUrl?.trim()
      ? `__Secure-authjs.callback-url=${config.webCallbackUrl.trim()}`
      : undefined,
  ].filter((item): item is string => Boolean(item && item.trim()));

  const response = await fetch(`${origin}/api/emails/${encodeURIComponent(emailId)}`, {
    method: "DELETE",
    headers: {
      Accept: "*/*",
      Origin: origin,
      Referer: config.webReferer?.trim() || `${origin}/zh-CN/moe`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
      Cookie: cookieParts.join("; "),
    },
  });

  const text = await response.text();
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } else {
    body = {};
  }

  if (response.status === 404) {
    return { released: true, detail: "already_missing" };
  }
  if (response.status === 401 || response.status === 403) {
    return { released: false, detail: "upstream_delete_unauthorized" };
  }
  if (response.status !== 200 && response.status !== 204) {
    throw buildStatusError("deleteMailboxWeb", response.status, body);
  }
  return { released: true, detail: "deleted" };
}

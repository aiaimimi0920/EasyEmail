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

import { execFile } from "node:child_process";
import type { ObservedMessage, ProviderInstance } from "../../domain/models.js";
import { extractOtpFromContent } from "../../domain/otp.js";

export interface TmailorConfig {
  apiBase: string;
  apiKey?: string;
}

export interface TmailorMailboxCredentials {
  email: string;
  token: string;
}

const TMAILOR_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.93 Safari/537.36";
const TRANSIENT_ERROR_RE = /(fetch failed|timeout|timed out|econnreset|socket hang up|network|status 5\d{2})/i;
const CAPACITY_ERROR_RE = /(status 429|too many requests|rate limit|quota)/i;
const CF_CHALLENGE_RE = /<!DOCTYPE html>.*Just a moment/is;
const TMAILOR_MAX_RETRIES = 2;
const TMAILOR_RETRY_BASE_DELAY_MS = 800;

function readMetadata(instance: ProviderInstance, key: string): string | undefined {
  const value = instance.metadata[key];
  return value && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : {};
}

function readStringLike(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }

  if (Array.isArray(value)) {
    const joined = value.map((item) => String(item)).join("\n").trim();
    return joined || undefined;
  }

  return undefined;
}

function normalizeFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function matchesSenderFilter(sender: string | undefined, fromContains: string | undefined): boolean {
  const normalizedFilter = normalizeFilter(fromContains);
  if (!normalizedFilter) {
    return true;
  }
  const normalizedSender = readStringLike(sender)?.toLowerCase();
  if (!normalizedSender) {
    return false;
  }
  return normalizedSender.includes(normalizedFilter);
}

function extractOtp(values: { subject?: string; textBody?: string; htmlBody?: string }) {
  return extractOtpFromContent(values);
}

function classifyTmailorError(message: string): "transient" | "capacity" | "provider" {
  const normalized = message.trim().toLowerCase();
  if (CAPACITY_ERROR_RE.test(normalized)) {
    return "capacity";
  }
  if (TRANSIENT_ERROR_RE.test(normalized)) {
    return "transient";
  }
  return "provider";
}

function formatTmailorError(phase: string, status: number): Error {
  const rawMessage = `Tmailor ${phase} failed with status ${status}.`;
  const category = classifyTmailorError(rawMessage);
  if (category === "capacity") {
    return new Error(`TMAILOR_CAPACITY_FAILURE: ${rawMessage}`);
  }
  if (category === "transient") {
    return new Error(`TMAILOR_TRANSIENT_FAILURE: ${rawMessage}`);
  }
  return new Error(`TMAILOR_PROVIDER_FAILURE: ${rawMessage}`);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isCfChallenge(status: number, body: string): boolean {
  return status === 403 && CF_CHALLENGE_RE.test(body.slice(0, 500));
}

function requestViaCloudscraper(
  apiUrl: string,
  jsonBody: Record<string, unknown>,
  apiKey: string | undefined,
): Promise<{ status: number; body: unknown }> {
  const pyScript = `
import cloudscraper, json, sys
s = cloudscraper.create_scraper()
s.headers.update({
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": sys.argv[1],
    "Referer": sys.argv[1] + "/",
})
${apiKey ? `s.headers["Authorization"] = "Bearer " + sys.argv[3]` : ""}
r = s.post(sys.argv[1] + "/api", json=json.loads(sys.argv[2]), timeout=30)
print(json.dumps({"status": r.status_code, "body": r.json() if "json" in r.headers.get("content-type", "") else r.text}))
`.trim();

  const args = [
    "-c",
    pyScript,
    apiUrl,
    JSON.stringify(jsonBody),
    ...(apiKey ? [apiKey] : []),
  ];

  return new Promise((resolve, reject) => {
    execFile("python", args, { timeout: 35_000 }, (error, stdout, stderr) => {
      if (error) {
        const msg = stderr?.trim() || error.message;
        if (/no module named.*cloudscraper/i.test(msg)) {
          reject(new Error("TMAILOR_PROVIDER_FAILURE: Cloudflare challenge active and Python cloudscraper is not installed. Run: python -m pip install cloudscraper"));
          return;
        }
        reject(new Error(`TMAILOR_TRANSIENT_FAILURE: cloudscraper subprocess failed: ${msg}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim()) as { status: number; body: unknown };
        resolve({ status: result.status, body: result.body });
      } catch {
        reject(new Error(`TMAILOR_PROVIDER_FAILURE: Failed to parse cloudscraper output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

async function requestJson(
  config: TmailorConfig,
  jsonBody: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const normalizedBase = config.apiBase.replace(/\/$/, "");

  for (let attempt = 0; attempt <= TMAILOR_MAX_RETRIES; attempt += 1) {
    const response = await fetch(`${normalizedBase}/api`, {
      method: "POST",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/json",
        "User-Agent": TMAILOR_USER_AGENT,
        "Origin": normalizedBase,
        "Referer": `${normalizedBase}/`,
        "sec-ch-ua": '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(jsonBody),
    });

    const text = await response.text();

    if (isCfChallenge(response.status, text)) {
      return await requestViaCloudscraper(normalizedBase, jsonBody, config.apiKey);
    }

    if ((response.status === 429 || response.status >= 500) && attempt < TMAILOR_MAX_RETRIES) {
      await sleep(TMAILOR_RETRY_BASE_DELAY_MS * (attempt + 1));
      continue;
    }

    return {
      status: response.status,
      body: text ? JSON.parse(text) : {},
    };
  }

  return { status: 599, body: {} };
}

export function resolveTmailorConfig(instance: ProviderInstance): TmailorConfig {
  return {
    apiBase: readMetadata(instance, "apiBase") ?? "https://tmailor.com",
    apiKey: readMetadata(instance, "apiKey"),
  };
}

export function encodeTmailorMailboxRef(instanceId: string, mailbox: TmailorMailboxCredentials): string {
  return `tmailor:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeTmailorMailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): TmailorMailboxCredentials | undefined {
  const normalizedRef = mailboxRef.trim();
  const normalizedInstanceId = expectedInstanceId.trim();
  if (!normalizedRef || !normalizedInstanceId) {
    return undefined;
  }

  const prefix = `tmailor:${normalizedInstanceId}:`;
  if (!normalizedRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(normalizedRef.slice(prefix.length))) as Record<string, unknown>;
    const email = readStringLike(payload.email) ?? "";
    const token = readStringLike(payload.token) ?? "";
    if (!email || !token || !email.includes("@")) {
      return undefined;
    }
    return { email: email.trim().toLowerCase(), token: token.trim() };
  } catch {
    return undefined;
  }
}

export class TmailorClient {
  public constructor(private readonly config: TmailorConfig) {}

  public static fromInstance(instance: ProviderInstance): TmailorClient {
    return new TmailorClient(resolveTmailorConfig(instance));
  }

  public async createMailbox(): Promise<TmailorMailboxCredentials> {
    const response = await requestJson(this.config, {
      action: "newemail",
      fbToken: null,
      curentToken: null,
    });

    if (response.status !== 200) {
      throw formatTmailorError("createMailbox", response.status);
    }

    const body = asRecord(response.body);
    if (body.msg !== "ok") {
      throw new Error(`TMAILOR_PROVIDER_FAILURE: Tmailor createMailbox returned msg=${String(body.msg)}.`);
    }

    const email = readStringLike(body.email) ?? "";
    const token = readStringLike(body.accesstoken) ?? "";
    if (!email || !token) {
      throw new Error("Tmailor createMailbox returned an incomplete mailbox payload.");
    }

    return { email, token };
  }

  public async listInbox(token: string): Promise<Record<string, Record<string, unknown>>> {
    const response = await requestJson(this.config, {
      action: "listinbox",
      accesstoken: token,
      curentToken: token,
      fbToken: null,
    });

    if (response.status === 429 || response.status >= 500) {
      throw formatTmailorError("listInbox", response.status);
    }
    if (response.status !== 200) {
      return {};
    }

    const body = asRecord(response.body);
    if (body.msg !== "ok") {
      return {};
    }

    const data = body.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return {};
    }

    return data as Record<string, Record<string, unknown>>;
  }

  public async readMailDetail(
    token: string,
    message: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await requestJson(this.config, {
      action: "read",
      accesstoken: token,
      curentToken: token,
      fbToken: null,
      email_code: message.id ?? message.uuid,
      email_token: message.email_id ?? message.uuid,
    });

    if (response.status === 429 || response.status >= 500) {
      throw formatTmailorError("readMailDetail", response.status);
    }
    if (response.status !== 200) {
      return {};
    }

    const body = asRecord(response.body);
    if (body.msg !== "ok") {
      return {};
    }

    return asRecord(body.data);
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: TmailorMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const inbox = await this.listInbox(mailbox.token);
    const messages = Object.values(inbox);

    for (const msg of messages) {
      const sender = readStringLike(msg.sender_email ?? msg.from ?? msg.sender);
      if (!matchesSenderFilter(sender, fromContains)) {
        continue;
      }

      const summarySubject = readStringLike(msg.subject);
      const summaryText = readStringLike(msg.text ?? msg.body);
      const summaryOtp = extractOtp({
        subject: summarySubject,
        textBody: summaryText,
      });

      const receiveTime = msg.receive_time
        ? String(Number(msg.receive_time) * 1000 > 1e12
            ? Number(msg.receive_time) * 1000
            : Number(msg.receive_time))
        : undefined;
      const observedAt = receiveTime
        ? new Date(Number(receiveTime)).toISOString()
        : readStringLike(msg.date ?? msg.createdAt) ?? "";

      if (summaryOtp) {
        const messageId = readStringLike(msg.id ?? msg.uuid) ?? sessionId;
        return {
          id: `tmailor:${messageId}`,
          sessionId,
          providerInstanceId,
          observedAt,
          sender,
          subject: summarySubject,
          textBody: summaryText,
          extractedCode: summaryOtp.code,
          codeSource: summaryOtp.source,
        };
      }

      const detail = await this.readMailDetail(mailbox.token, msg);
      const detailSender = readStringLike(detail.sender_email ?? detail.from ?? detail.sender) ?? sender;
      if (!matchesSenderFilter(detailSender, fromContains)) {
        continue;
      }

      const detailSubject = readStringLike(detail.subject) ?? summarySubject;
      const textBody = readStringLike(detail.textBody ?? detail.text ?? detail.body) ?? summaryText;
      const htmlBody = readStringLike(detail.htmlBody ?? detail.html ?? detail.body_html);
      const detailOtp = extractOtp({
        subject: detailSubject,
        textBody,
        htmlBody,
      });
      const messageId = readStringLike(msg.id ?? msg.uuid)
        ?? readStringLike(detail.id)
        ?? sessionId;

      return {
        id: `tmailor:${messageId}`,
        sessionId,
        providerInstanceId,
        observedAt,
        sender: detailSender,
        subject: detailSubject,
        textBody,
        htmlBody,
        extractedCode: detailOtp?.code,
        codeSource: detailOtp?.source,
      };
    }

    return undefined;
  }
}

export async function probeTmailorInstance(instance: ProviderInstance): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const client = TmailorClient.fromInstance(instance);
  const startedAt = Date.now();
  try {
    const mailbox = await client.createMailbox();
    const ok = Boolean(mailbox.email && mailbox.token);
    return {
      ok,
      detail: ok
        ? `TMAILOR_PROBE_OK: Tmailor created mailbox ${mailbox.email}.`
        : "TMAILOR_PROVIDER_FAILURE: Tmailor returned incomplete mailbox.",
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "tmailor",
        state: ok ? "ok" : "incomplete-response",
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const classification = classifyTmailorError(detail);
    return {
      ok: false,
      detail,
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "tmailor",
        errorClass: classification,
      },
    };
  }
}

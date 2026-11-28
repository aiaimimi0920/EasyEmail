import { randomUUID } from "node:crypto";
import { EasyEmailError } from "../domain/errors.js";
import { sanitizeSafeMailHtml } from "../domain/mail-safe-html-engine.js";

const DEFAULT_BASE_URL = "https://www.workbuddy.cn";
const ALLOWED_DOMAINS = new Set([
  "www.workbuddy.cn",
  "copilot.tencent.com",
  "www.codebuddy.cn",
  "wb.tencentbuddy.com",
]);

export interface LocalWorkBuddyAccountPublic {
  id: string;
  aliasId: string;
  emailAddress: string;
  displayName: string;
  domain: string;
  baseUrl: string;
  mailboxStatus: string;
  dailyQuota: { limit: number; remaining: number; reset: number; hasQuota: boolean };
  updatedAt: string;
}

export interface StoredWorkBuddyAccount extends LocalWorkBuddyAccountPublic {
  accessToken: string;
  refreshToken: string;
  uid: string;
  enterpriseId?: string;
  tenantId?: string;
}

export interface OmnimailWorkBuddyPersistencePort {
  listWorkBuddyAccounts(): StoredWorkBuddyAccount[];
  upsertWorkBuddyAccount(account: StoredWorkBuddyAccount): void;
  deleteWorkBuddyAccount(id: string): boolean;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function resolveBase(raw: string | undefined, allowLoopback: boolean): { baseUrl: string; domain: string } {
  let trimmed = (raw ?? "").trim();
  if (!trimmed) trimmed = DEFAULT_BASE_URL;
  else if (!trimmed.includes("://")) trimmed = `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new EasyEmailError("INVALID_WORKBUDDY_DOMAIN", "Invalid WorkBuddy base URL.");
  }
  const host = parsed.hostname.toLowerCase();
  if (allowLoopback && isLoopback(host) && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return { baseUrl: `${parsed.protocol}//${parsed.host}`, domain: parsed.host };
  }
  if (parsed.protocol !== "https:" || !ALLOWED_DOMAINS.has(host)) {
    throw new EasyEmailError("INVALID_WORKBUDDY_DOMAIN", "WorkBuddy host is not on the official HTTPS allowlist.");
  }
  return { baseUrl: `https://${parsed.host}`, domain: parsed.host };
}

function parseQuota(headers: Headers) {
  const lim = Number.parseInt(headers.get("x-dailyquota-limit") ?? "", 10);
  const rem = Number.parseInt(headers.get("x-dailyquota-remaining") ?? "", 10);
  const rst = Number.parseInt(headers.get("x-dailyquota-reset") ?? "", 10);
  return {
    limit: Number.isFinite(lim) ? lim : 0,
    remaining: Number.isFinite(rem) ? rem : 0,
    reset: Number.isFinite(rst) ? rst : 0,
    hasQuota: Number.isFinite(lim) || Number.isFinite(rem) || Number.isFinite(rst),
  };
}

export class LocalWorkBuddyAgentService {
  private readonly authSessions = new Map<string, { baseUrl: string; domain: string; authUrl: string; expiresAt: number }>();
  private readonly accounts = new Map<string, StoredWorkBuddyAccount>();

  public constructor(
    private readonly allowLoopback = false,
    private readonly persistence?: OmnimailWorkBuddyPersistencePort,
  ) {
    for (const saved of persistence?.listWorkBuddyAccounts() ?? []) {
      this.accounts.set(saved.id, saved);
    }
  }

  public listAccounts(): LocalWorkBuddyAccountPublic[] {
    return [...this.accounts.values()].map(({ accessToken: _a, refreshToken: _r, uid: _u, enterpriseId: _e, tenantId: _t, ...pub }) => pub);
  }

  public removeAccount(accountId: string): boolean {
    const memRemoved = this.accounts.delete(accountId);
    const dbRemoved = this.persistence?.deleteWorkBuddyAccount(accountId) ?? false;
    return memRemoved || dbRemoved;
  }

  public async startAuth(baseUrlInput?: string): Promise<{ state: string; authUrl: string; baseUrl: string }> {
    const { baseUrl, domain } = resolveBase(baseUrlInput, this.allowLoopback);
    const resp = await fetch(`${baseUrl}/v2/plugin/auth/state?platform=workbuddy`, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-product": "SaaS",
        "x-domain": domain,
      },
      body: "{}",
    });
    const json = (await resp.json().catch(() => ({}))) as { code?: number; data?: { state?: string; authUrl?: string } };
    const state = json.data?.state?.trim() ?? "";
    const authUrl = json.data?.authUrl?.trim() ?? "";
    if (!resp.ok || !state || !authUrl) {
      throw new EasyEmailError("WORKBUDDY_GATEWAY_FAILED", "Failed to start WorkBuddy browser auth.");
    }
    this.authSessions.set(state, { baseUrl, domain, authUrl, expiresAt: Date.now() + 600_000 });
    return { state, authUrl, baseUrl };
  }

  public async pollAuth(state: string): Promise<{ stage: "polling" | "authorized"; account?: LocalWorkBuddyAccountPublic }> {
    const session = this.authSessions.get(state.trim());
    if (!session || session.expiresAt <= Date.now()) {
      throw new EasyEmailError("WORKBUDDY_AUTH_EXPIRED", "WorkBuddy auth session expired.");
    }
    const tokenResp = await fetch(`${session.baseUrl}/v2/plugin/auth/token?state=${encodeURIComponent(state.trim())}`, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json", "x-product": "SaaS", "x-domain": session.domain },
    });
    if (tokenResp.status === 202) return { stage: "polling" };
    const tokenBody = (await tokenResp.json().catch(() => ({}))) as {
      code?: number;
      data?: { status?: string; accessToken?: string; refreshToken?: string };
    };
    if (tokenBody.code === 11217 || !tokenBody.data?.accessToken?.trim()) {
      return { stage: "polling" };
    }
    const accessToken = tokenBody.data.accessToken.trim();
    const refreshToken = (tokenBody.data.refreshToken ?? "").trim();
    const acctResp = await fetch(`${session.baseUrl}/v2/plugin/account`, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "x-domain": session.domain,
        "x-product": "SaaS",
      },
    });
    const acctBody = (await acctResp.json().catch(() => ({}))) as {
      data?: { uid?: string; id?: string; userId?: string; enterpriseId?: string; tenantId?: string };
    };
    const uid = (acctBody.data?.uid || acctBody.data?.id || acctBody.data?.userId || "").trim();
    if (!acctResp.ok || !uid) {
      throw new EasyEmailError("WORKBUDDY_GATEWAY_FAILED", "Failed to resolve WorkBuddy UID.");
    }

    const meResp = await fetch(`${session.baseUrl}/console/agent-gateway/agentmailrest/v1/me`, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "x-domain": session.domain,
        "x-user-id": encodeURIComponent(uid),
      },
    });
    const quota = parseQuota(meResp.headers);
    const meBody = (await meResp.json().catch(() => ({}))) as {
      data?: { aliases?: Array<{ alias_id?: string; aliasId?: string; email?: string; is_primary?: boolean }> };
    };
    const aliases = (meBody.data?.aliases ?? [])
      .map((a) => ({ aliasId: (a.alias_id || a.aliasId || "").trim(), email: (a.email ?? "").trim(), isPrimary: Boolean(a.is_primary) }))
      .filter((a) => a.aliasId && a.email);
    if (aliases.length === 0) {
      throw new EasyEmailError("WORKBUDDY_NOT_BOUND", "No active WorkBuddy mailbox alias bound.");
    }
    const primary = aliases.find((a) => a.isPrimary) ?? aliases[0]!;
    const existing = [...this.accounts.values()].find((a) => a.emailAddress.toLowerCase() === primary.email.toLowerCase());
    const id = existing?.id ?? randomUUID();
    const record: StoredWorkBuddyAccount = {
      id,
      aliasId: primary.aliasId,
      emailAddress: primary.email,
      displayName: primary.email,
      domain: session.domain,
      baseUrl: session.baseUrl,
      mailboxStatus: "running",
      dailyQuota: quota,
      updatedAt: new Date().toISOString(),
      accessToken,
      refreshToken,
      uid,
      enterpriseId: acctBody.data?.enterpriseId,
      tenantId: acctBody.data?.tenantId ?? acctBody.data?.enterpriseId,
    };
    this.accounts.set(id, record);
    this.persistence?.upsertWorkBuddyAccount(record);
    this.authSessions.delete(state.trim());
    const { accessToken: _a, refreshToken: _r, uid: _u, enterpriseId: _e, tenantId: _t, ...pub } = record;
    return { stage: "authorized", account: pub };
  }

  private getAccountOrThrow(accountId: string): StoredWorkBuddyAccount {
    const acc = this.accounts.get(accountId);
    if (!acc) throw new EasyEmailError("WORKBUDDY_ACCOUNT_NOT_FOUND", `WorkBuddy account '${accountId}' not found.`);
    return acc;
  }

  private async callRest(account: StoredWorkBuddyAccount, method: string, relPath: string, query?: Record<string, string>, body?: unknown) {
    const exec = async (token: string) => {
      const qs = query ? new URLSearchParams(query).toString() : "";
      const headers: Record<string, string> = {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "x-domain": account.domain,
        "x-user-id": encodeURIComponent(account.uid),
      };
      if (account.enterpriseId) headers["x-enterprise-id"] = account.enterpriseId;
      if (account.tenantId) headers["x-tenant-id"] = account.tenantId;
      if (body !== undefined) headers["content-type"] = "application/json";
      return fetch(`${account.baseUrl}${relPath}${qs ? `?${qs}` : ""}`, {
        method,
        redirect: "error",
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    };
    let resp = await exec(account.accessToken);
    if (resp.status === 401 && account.refreshToken) {
      const ref = await fetch(`${account.baseUrl}/v2/plugin/auth/token/refresh`, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-refresh-token": account.refreshToken,
          "x-auth-refresh-source": "plugin",
          "x-domain": account.domain,
          "x-product": "SaaS",
        },
        body: "{}",
      });
      const refBody = (await ref.json().catch(() => ({}))) as { data?: { accessToken?: string; refreshToken?: string } };
      if (ref.ok && refBody.data?.accessToken) {
        account.accessToken = refBody.data.accessToken.trim();
        if (refBody.data.refreshToken) account.refreshToken = refBody.data.refreshToken.trim();
        account.updatedAt = new Date().toISOString();
        this.persistence?.upsertWorkBuddyAccount(account);
        resp = await exec(account.accessToken);
      }
    }
    const quota = parseQuota(resp.headers);
    if (quota.hasQuota) {
      account.dailyQuota = quota;
      this.persistence?.upsertWorkBuddyAccount(account);
    }
    const json = await resp.json().catch(() => ({}));
    return { status: resp.status, json: json as Record<string, unknown>, quota };
  }

  public async listMessages(accountId: string, dir: "inbox" | "sent" = "inbox", q?: string, cursor?: string) {
    const acc = this.getAccountOrThrow(accountId);
    const query: Record<string, string> = { dir, limit: "50" };
    if (cursor) query.cursor = cursor;
    let relPath = `/console/agent-gateway/agentmailrest/v1/aliases/${encodeURIComponent(acc.aliasId)}/messages`;
    if (q?.trim()) {
      relPath += "/search";
      query.q = q.trim();
      query.search_in = "SEARCH_IN_ALL";
    }
    const { status, json, quota } = await this.callRest(acc, "GET", relPath, query);
    if (status >= 400) throw new EasyEmailError("WORKBUDDY_GATEWAY_FAILED", `WorkBuddy HTTP ${status}`);
    const data = Array.isArray(json.data) ? (json.data as Array<Record<string, unknown>>) : [];
    return {
      items: data.map((r) => ({
        messageId: String(r.message_id ?? ""),
        subject: String(r.subject ?? ""),
        from: typeof r.from === "string" ? r.from : String((r.from as { email?: string })?.email ?? ""),
        snippet: String(r.snippet ?? ""),
        createdAt: String(r.created_at ?? ""),
        isRead: Boolean(r.is_read),
        hasAttachments: Boolean(r.has_attachments),
      })),
      dailyQuota: quota,
    };
  }

  public async getMessageDetail(accountId: string, messageId: string) {
    const acc = this.getAccountOrThrow(accountId);
    const { status, json, quota } = await this.callRest(
      acc,
      "GET",
      `/console/agent-gateway/agentmailrest/v1/aliases/${encodeURIComponent(acc.aliasId)}/messages/${encodeURIComponent(messageId)}`,
    );
    if (status >= 400) throw new EasyEmailError("WORKBUDDY_GATEWAY_FAILED", `WorkBuddy HTTP ${status}`);
    const raw = ((json.data ?? json) as Record<string, unknown>);
    const isHtml = String(raw.body_format ?? "").toUpperCase() === "HTML";
    const body = String(raw.body ?? "");
    const safe = isHtml ? sanitizeSafeMailHtml(body, { allowRemoteImages: false }) : null;
    return {
      messageId: String(raw.message_id ?? messageId),
      subject: String(raw.subject ?? ""),
      from: typeof raw.from === "string" ? raw.from : String((raw.from as { email?: string })?.email ?? ""),
      plainText: safe ? safe.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : body,
      sanitizedHtml: safe ? safe.html : "",
      dailyQuota: quota,
    };
  }

  public async deleteMessage(accountId: string, messageId: string, confirmationToken?: string) {
    const acc = this.getAccountOrThrow(accountId);
    const { status, json, quota } = await this.callRest(
      acc,
      "DELETE",
      `/console/agent-gateway/agentmailrest/v1/aliases/${encodeURIComponent(acc.aliasId)}/messages/${encodeURIComponent(messageId)}`,
      confirmationToken ? { confirmation_token: confirmationToken } : undefined,
    );
    if (!confirmationToken) {
      const errTok = (json.error as { code?: string; details?: { confirmation_token?: string } } | undefined)?.details?.confirmation_token;
      const dataTok = (json.data as { confirmation_token?: string } | undefined)?.confirmation_token;
      const token = (errTok || dataTok || "").trim();
      if (token) {
        return { messageId, needsConfirmation: true, confirmationToken: token, deleted: false, dailyQuota: quota };
      }
    }
    if (status >= 400) throw new EasyEmailError("WORKBUDDY_GATEWAY_FAILED", `WorkBuddy delete HTTP ${status}`);
    return { messageId, needsConfirmation: false, deleted: true, dailyQuota: quota };
  }
}

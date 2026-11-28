import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { openVault, sealVault } from "./mailbox-vault";
import {
  deleteWorkBuddyAliasMessage,
  downloadWorkBuddyAliasAttachment,
  fetchWorkBuddyProfileAndAliases,
  getWorkBuddyAliasMessageDetail,
  listWorkBuddyAliasMessages,
  pollWorkBuddyAuthTokenOnce,
  requestWorkBuddyGateway,
  startWorkBuddyBrowserAuth,
  type WorkBuddyDailyQuota,
  type WorkBuddyTokenCredentials,
} from "./workbuddy-client";

interface WorkBuddyAccountRow {
  id: string;
  user_id: string;
  alias_id: string;
  email_address: string;
  display_name: string;
  domain: string;
  base_url: string;
  mailbox_status: string;
  token_cipher: string;
  daily_limit: number;
  daily_remaining: number;
  daily_reset: number;
  enabled: number;
  revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface WorkBuddyAuthSessionRow {
  state: string;
  user_id: string;
  base_url: string;
  domain: string;
  auth_url: string;
  created_at: number;
  expires_at: number;
  completed_at: number | null;
}

function wbVaultContext(userId: string, accountId: string) {
  return { id: accountId, user_id: userId, provider_id: "workbuddy-agent", purpose: "ee-workbuddy-v1" };
}

function toAccountDto(row: WorkBuddyAccountRow) {
  return {
    id: row.id,
    aliasId: row.alias_id,
    emailAddress: row.email_address,
    displayName: row.display_name || row.email_address,
    domain: row.domain,
    baseUrl: row.base_url,
    mailboxStatus: row.mailbox_status,
    dailyQuota: {
      limit: row.daily_limit,
      remaining: row.daily_remaining,
      reset: row.daily_reset,
      hasQuota: row.daily_limit > 0 || row.daily_remaining > 0,
    },
    enabled: row.enabled === 1,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

async function getOwnedAccount(env: Env, userId: string, id: string): Promise<WorkBuddyAccountRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM workbuddy_accounts WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
  )
    .bind(id, userId)
    .first<WorkBuddyAccountRow>();
  if (!row) throw new HttpError(404, "not_found");
  return row;
}

async function persistQuota(env: Env, accountId: string, quota: WorkBuddyDailyQuota) {
  if (!quota.hasQuota) return;
  await env.DB.prepare(
    "UPDATE workbuddy_accounts SET daily_limit = ?, daily_remaining = ?, daily_reset = ?, updated_at = ? WHERE id = ?",
  )
    .bind(quota.limit, quota.remaining, quota.reset, unixNow(), accountId)
    .run();
}

export const isWorkBuddyPath = (path: string) => path.startsWith("/api/v1/workbuddy/");

export async function workBuddyRoute(request: Request, env: Env, identity: Identity): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const allowLoopback = env.WORKBUDDY_ALLOW_LOOPBACK === "true";

  if (path === "/api/v1/workbuddy/accounts" && request.method === "GET") {
    requireScope(identity, "workbuddy:read");
    try {
      const { results } = await env.DB.prepare(
        "SELECT * FROM workbuddy_accounts WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
      )
        .bind(identity.userId)
        .all<WorkBuddyAccountRow>();
      return json({ items: results.map(toAccountDto) });
    } catch {
      throw new HttpError(503, "workbuddy_schema_required");
    }
  }

  if (path === "/api/v1/workbuddy/auth/start" && request.method === "POST") {
    requireWriteScope(request, env, identity, "workbuddy:write");
    const body = await readJson(request);
    const started = await startWorkBuddyBrowserAuth(
      typeof body.baseUrl === "string" ? body.baseUrl : undefined,
      allowLoopback,
    );
    const now = unixNow();
    await env.DB.prepare(
      `INSERT INTO workbuddy_auth_sessions (state, user_id, base_url, domain, auth_url, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(started.state, identity.userId, started.baseUrl, started.domain, started.authUrl, now, now + 600)
      .run();
    return json({ auth: started }, 201);
  }

  if (path === "/api/v1/workbuddy/auth/poll" && request.method === "POST") {
    requireWriteScope(request, env, identity, "workbuddy:write");
    const body = await readJson(request);
    const state = String(body.state ?? "").trim();
    if (!state) throw new HttpError(400, "invalid_workbuddy_request");
    const session = await env.DB.prepare(
      "SELECT * FROM workbuddy_auth_sessions WHERE state = ? AND user_id = ?",
    )
      .bind(state, identity.userId)
      .first<WorkBuddyAuthSessionRow>();
    if (!session || session.expires_at <= unixNow()) {
      throw new HttpError(410, "workbuddy_auth_expired");
    }
    const polled = await pollWorkBuddyAuthTokenOnce(
      session.base_url,
      session.domain,
      state,
      allowLoopback,
    );
    if (polled.pending) {
      return json({ stage: "polling" });
    }
    const profile = await fetchWorkBuddyProfileAndAliases(polled.credentials, allowLoopback);
    const existing = await env.DB.prepare(
      "SELECT * FROM workbuddy_accounts WHERE user_id = ? AND email_address = ? AND deleted_at IS NULL",
    )
      .bind(identity.userId, profile.primary.email)
      .first<WorkBuddyAccountRow>();
    const accountId = existing?.id ?? crypto.randomUUID();
    const cipher = await sealVault(env, wbVaultContext(identity.userId, accountId), polled.credentials);
    const now = unixNow();
    if (existing) {
      await env.DB.prepare(
        `UPDATE workbuddy_accounts SET alias_id = ?, domain = ?, base_url = ?, mailbox_status = ?,
         token_cipher = ?, daily_limit = ?, daily_remaining = ?, daily_reset = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
        .bind(
          profile.primary.aliasId,
          polled.credentials.domain,
          polled.credentials.baseUrl,
          profile.mailboxStatus,
          cipher,
          profile.quota.limit,
          profile.quota.remaining,
          profile.quota.reset,
          now,
          accountId,
          identity.userId,
        )
        .run();
    } else {
      await env.DB.prepare(
        `INSERT INTO workbuddy_accounts (
          id, user_id, alias_id, email_address, display_name, domain, base_url, mailbox_status,
          token_cipher, daily_limit, daily_remaining, daily_reset, enabled, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      )
        .bind(
          accountId,
          identity.userId,
          profile.primary.aliasId,
          profile.primary.email,
          profile.primary.email,
          polled.credentials.domain,
          polled.credentials.baseUrl,
          profile.mailboxStatus,
          cipher,
          profile.quota.limit,
          profile.quota.remaining,
          profile.quota.reset,
          now,
          now,
        )
        .run();
    }
    await env.DB.prepare("UPDATE workbuddy_auth_sessions SET completed_at = ? WHERE state = ?")
      .bind(now, state)
      .run();
    const saved = await getOwnedAccount(env, identity.userId, accountId);
    return json({ stage: "authorized", account: toAccountDto(saved), aliases: profile.aliases });
  }

  const accountMatch = /^\/api\/v1\/workbuddy\/accounts\/([0-9a-f-]{36})(?:\/(.*))?$/.exec(path);
  if (!accountMatch) throw new HttpError(404, "not_found");
  const accountId = accountMatch[1]!;
  const subPath = accountMatch[2] ?? "";

  if (!subPath && request.method === "DELETE") {
    requireWriteScope(request, env, identity, "workbuddy:write");
    const row = await getOwnedAccount(env, identity.userId, accountId);
    await env.DB.prepare(
      "UPDATE workbuddy_accounts SET token_cipher = '', enabled = 0, deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND user_id = ?",
    )
      .bind(unixNow(), unixNow(), row.id, identity.userId)
      .run();
    return json({ removed: true });
  }

  const row = await getOwnedAccount(env, identity.userId, accountId);
  const creds = await openVault<WorkBuddyTokenCredentials>(
    env,
    wbVaultContext(identity.userId, row.id),
    row.token_cipher,
  );
  const onRefreshed = async (next: WorkBuddyTokenCredentials) => {
    const sealed = await sealVault(env, wbVaultContext(identity.userId, row.id), next);
    await env.DB.prepare("UPDATE workbuddy_accounts SET token_cipher = ?, updated_at = ? WHERE id = ?")
      .bind(sealed, unixNow(), row.id)
      .run();
  };

  if (subPath === "refresh-status" && request.method === "POST") {
    requireWriteScope(request, env, identity, "workbuddy:read");
    const profile = await fetchWorkBuddyProfileAndAliases(creds, allowLoopback, onRefreshed);
    await persistQuota(env, row.id, profile.quota);
    const updated = await getOwnedAccount(env, identity.userId, row.id);
    return json({ account: toAccountDto(updated), aliases: profile.aliases });
  }

  if (subPath === "messages" && request.method === "GET") {
    requireScope(identity, "workbuddy:read");
    const dir = url.searchParams.get("dir") === "sent" ? "sent" : "inbox";
    const page = await listWorkBuddyAliasMessages({
      creds,
      aliasId: row.alias_id,
      dir,
      query: url.searchParams.get("q") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? "50"),
      allowLoopback,
      onRefreshed,
    });
    await persistQuota(env, row.id, page.dailyQuota);
    return json(page);
  }

  const msgMatch = /^messages\/([^/]+)(?:\/(.*))?$/.exec(subPath);
  if (!msgMatch) throw new HttpError(404, "not_found");
  const messageId = decodeURIComponent(msgMatch[1]!);
  const msgAction = msgMatch[2] ?? "";

  if (!msgAction && request.method === "GET") {
    requireScope(identity, "workbuddy:read");
    const detail = await getWorkBuddyAliasMessageDetail({
      creds,
      aliasId: row.alias_id,
      messageId,
      allowLoopback,
      onRefreshed,
    });
    await persistQuota(env, row.id, detail.dailyQuota);
    return json({ message: detail });
  }

  if (msgAction === "read" && request.method === "POST") {
    requireWriteScope(request, env, identity, "workbuddy:write");
    const resp = await requestWorkBuddyGateway({
      creds,
      method: "POST",
      relPath: `/console/agent-gateway/agentmailrest/v1/aliases/${encodeURIComponent(row.alias_id)}/messages/${encodeURIComponent(messageId)}/update`,
      jsonBody: { is_read: true },
      allowLoopback,
      onRefreshed,
    });
    await persistQuota(env, row.id, resp.quota);
    return json({ ok: true, dailyQuota: resp.quota });
  }

  if (!msgAction && request.method === "DELETE") {
    requireWriteScope(request, env, identity, "workbuddy:write");
    const result = await deleteWorkBuddyAliasMessage({
      creds,
      aliasId: row.alias_id,
      messageId,
      confirmationToken: url.searchParams.get("confirmationToken") ?? undefined,
      allowLoopback,
      onRefreshed,
    });
    await persistQuota(env, row.id, result.dailyQuota);
    return json({ result });
  }

  const attMatch = /^attachments\/([^/]+)$/.exec(msgAction);
  if (attMatch && request.method === "GET") {
    requireScope(identity, "workbuddy:read");
    const downloaded = await downloadWorkBuddyAliasAttachment({
      creds,
      aliasId: row.alias_id,
      messageId,
      attachmentId: decodeURIComponent(attMatch[1]!),
      allowLoopback,
      onRefreshed,
    });
    const bodyCopy = new Uint8Array(downloaded.bytes.byteLength);
    bodyCopy.set(downloaded.bytes);
    return new Response(bodyCopy.buffer, {
      status: 200,
      headers: {
        "content-type": downloaded.contentType,
        "content-disposition": `attachment; filename="${downloaded.filename}"`,
      },
    });
  }

  throw new HttpError(405, "method_not_allowed");
}

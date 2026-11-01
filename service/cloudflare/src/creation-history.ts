import type { Env, Identity } from "./contracts";
import { HttpError, json, pageOptions, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { creationAddressView } from "./creation-address";

interface CreationRow {
  mailbox_id: string; request_key: string; address: string; provider_id: string | null;
  state: "pending" | "unknown" | "complete"; error_code: string | null;
  created_at: number; expires_at: number | null; acknowledged_at: number | null;
}
const COLUMNS = "mailbox_id,request_key,address,provider_id,state,error_code,created_at,expires_at,acknowledged_at";
const SAFE_ERRORS = new Set(["provider_auth_failed", "provider_rate_limited", "provider_timeout", "provider_unavailable",
  "provider_invalid_response", "provider_response_too_large", "provider_recipient_mismatch", "provider_domains_mismatch", "creation_storage_failed", "mailbox_address_unavailable"]);

function creationView(row: CreationRow) {
  return { id: row.mailbox_id, mailboxId: row.mailbox_id, requestKey: row.request_key, providerId: row.provider_id,
    ...creationAddressView(row), state: row.state, error: row.error_code ? SAFE_ERRORS.has(row.error_code) ? row.error_code : "creation_unconfirmed" : null,
    createdAt: row.created_at, expiresAt: row.expires_at, acknowledgedAt: row.acknowledged_at, retrySafe: false,
    origin: row.request_key.startsWith('recover:') ? 'imported' : 'created' };
}

async function ownedCreation(env: Env, identity: Identity, id: string): Promise<CreationRow> {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM mailbox_creations WHERE user_id=? AND mailbox_id=?`)
    .bind(identity.userId, id).first<CreationRow>();
  if (!row) throw new HttpError(404, "not_found");
  return row;
}

async function listCreations(request: Request, env: Env, identity: Identity): Promise<Response> {
  requireScope(identity, "mailboxes:read");
  const url = new URL(request.url), { limit, cursor } = pageOptions(url), state = url.searchParams.get("state");
  if ([...url.searchParams.keys()].some((key) => !["limit", "cursor", "state"].includes(key))
    || (state !== null && state !== "unresolved")) throw new HttpError(400, "invalid_creation_filter");
  const after = cursor ? await env.DB.prepare("SELECT created_at FROM mailbox_creations WHERE user_id=? AND mailbox_id=?")
    .bind(identity.userId, cursor).first<{ created_at: number }>() : null;
  if (cursor && !after) throw new HttpError(400, "invalid_cursor");
  const { results } = await env.DB.prepare(`SELECT ${COLUMNS} FROM mailbox_creations WHERE user_id=?
    ${state ? "AND state IN ('pending','unknown') AND acknowledged_at IS NULL" : ""}
    ${after ? "AND (created_at<? OR (created_at=? AND mailbox_id<?))" : ""}
    ORDER BY created_at DESC,mailbox_id DESC LIMIT ?`)
    .bind(identity.userId, ...(after ? [after.created_at, after.created_at, cursor] : []), limit + 1).all<CreationRow>();
  const items = results.slice(0, limit);
  return json({ items: items.map(creationView), nextCursor: results.length > limit ? items.at(-1)!.mailbox_id : null });
}

async function acknowledgeCreation(request: Request, env: Env, identity: Identity, id: string): Promise<Response> {
  requireWriteScope(request, env, identity, "mailboxes:write");
  const body = await readJson(request), row = await ownedCreation(env, identity, id);
  const pendingAddress = creationAddressView(row).address === null, field = pendingAddress ? "confirmRequestKey" : "confirmAddress";
  if (Object.keys(body).some((key) => ![field, "acknowledgeUncertain"].includes(key))
    || body[field] !== (pendingAddress ? row.request_key : row.address) || body.acknowledgeUncertain !== true) throw new HttpError(400, "creation_confirmation_required");
  const updated = await env.DB.prepare(`UPDATE mailbox_creations SET acknowledged_at=COALESCE(acknowledged_at,unixepoch())
    WHERE user_id=? AND mailbox_id=? AND address=? AND state IN ('pending','unknown') RETURNING ${COLUMNS}`)
    .bind(identity.userId, id, row.address).first<CreationRow>();
  if (!updated) throw new HttpError(409, "creation_state_changed");
  return json({ creation: creationView(updated) });
}

export function isCreationPath(path: string): boolean {
  return path === "/api/v1/mailbox-creations" || /^\/api\/v1\/mailbox-creations\/[0-9a-f-]{36}(?:\/acknowledge)?$/.test(path);
}

export async function creationRoute(request: Request, env: Env, identity: Identity): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/v1/mailbox-creations" && request.method === "GET") return listCreations(request, env, identity);
  const match = /^\/api\/v1\/mailbox-creations\/([0-9a-f-]{36})(\/acknowledge)?$/.exec(path);
  if (match?.[2] && request.method === "POST") return acknowledgeCreation(request, env, identity, match[1]);
  if (match && !match[2] && request.method === "GET") {
    requireScope(identity, "mailboxes:read");
    return json({ creation: creationView(await ownedCreation(env, identity, match[1])) });
  }
  throw new HttpError(405, "method_not_allowed");
}

import { unixNow, type Env, type Identity } from "./contracts";
import { ADMIN_EXISTS, requireAdministrator } from "./admin-access";
import { HttpError, json, readJson } from "./http";
import { parseRetentionPolicy, readRetention, RETENTION_DAYS } from "./retention-policy";
import { lastRetentionRun, previewRetention } from "./retention-store";
import { runRetention } from "./retention-run";
import { rateLimit } from "./rate-limits";
import { tokenHash } from "./security";
import { normalInboxCleanupStatus } from "./normal-inbox-cleanup";

function expectedRevision(body: Record<string, unknown>, fields: string[]): number {
  if (Object.keys(body).some((key) => !fields.includes(key)) || !Number.isSafeInteger(body.expectedRevision)
    || (body.expectedRevision as number) < 0) throw new HttpError(400, "invalid_retention_request");
  return body.expectedRevision as number;
}

export async function retentionAdmin(request: Request, env: Env, identity: Identity): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/v1/admin/retention" && request.method === "GET") {
    return json({ ...await readRetention(env), lastRun: await lastRetentionRun(env), normalObjects: await normalInboxCleanupStatus(env) });
  }
  if (path === "/api/v1/admin/retention" && request.method === "PUT") {
    const body = await readJson(request), revision = expectedRevision(body, ["policy", "expectedRevision", "confirm"]);
    if (body.confirm !== "APPLY RETENTION") throw new HttpError(400, "retention_confirmation_required");
    const policy = parseRetentionPolicy(body.policy), now = unixNow(), token = crypto.randomUUID();
    await rateLimit(env, "retention-configure", identity.userId, 10);
    const writes = await env.DB.batch([
      env.DB.prepare(`UPDATE retention_policy SET enabled=?,mailbox_days=?,cache_days=?,trash_days=?,outgoing_days=?,audit_days=?,
        revision=revision+1,change_token=?,updated_at=?,actor_id=? WHERE id=1 AND revision=? AND ${ADMIN_EXISTS}`)
        .bind(Number(policy.enabled), ...RETENTION_DAYS.map((key) => policy[key]), token, now, identity.userId, revision, identity.userId),
      env.DB.prepare(`INSERT INTO retention_policy_changes(id,actor_id,revision,created_at)
        SELECT ?,?,revision,? FROM retention_policy WHERE id=1 AND change_token=? AND revision=?`)
        .bind(token, identity.userId, now, token, revision + 1),
    ]);
    if (!writes[0].meta.changes) { await requireAdministrator(request, env, identity); throw new HttpError(409, "retention_policy_changed"); }
    return json({ ...await readRetention(env), lastRun: await lastRetentionRun(env), normalObjects: await normalInboxCleanupStatus(env) });
  }
  if (path === "/api/v1/admin/retention/preview" && request.method === "POST") {
    const body = await readJson(request), revision = expectedRevision(body, ["policy", "expectedRevision"]);
    const policy = parseRetentionPolicy(body.policy);
    await rateLimit(env, "retention-preview", identity.userId, 10);
    if ((await readRetention(env)).revision !== revision) throw new HttpError(409, "retention_policy_changed");
    return json({ preview: await previewRetention(env, policy, unixNow()), revision, normalObjects: await normalInboxCleanupStatus(env) });
  }
  if (path === "/api/v1/admin/retention/run" && request.method === "POST") {
    const body = await readJson(request), revision = expectedRevision(body, ["expectedRevision", "confirm"]);
    if (body.confirm !== "RUN RETENTION") throw new HttpError(400, "retention_confirmation_required");
    const key = request.headers.get("idempotency-key") ?? "";
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, "idempotency_key_required");
    await rateLimit(env, "retention-run", identity.userId, 5);
    const result = await runRetention(env, { key: await tokenHash(`retention:manual:${identity.userId}:${key}`), revision,
      actorId: identity.userId, trigger: "manual" });
    return json({ ...result, normalObjects: await normalInboxCleanupStatus(env) });
  }
  throw new HttpError(405, "method_not_allowed");
}

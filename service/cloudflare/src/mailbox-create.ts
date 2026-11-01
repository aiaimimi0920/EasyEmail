import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireWriteScope } from "./identity";
import { getMailbox } from "./mailbox-queries";
import { assertVault, encryptCredential } from "./mailbox-vault";
import { connectProvider } from "./providers/registry";
import { rateLimit } from "./rate-limits";
import { randomToken } from "./security";
import { assertProviderRevision, PROVIDER_REVISION_FENCE } from "./providers/settings";
import { MAILBOX_QUOTAS } from "./quota-policy";
import { readRetention, RETENTION_POLICY_FENCE } from "./retention-policy";
import { allocationInput, type AllocationInput } from "./allocation-input";
import { selectAllocation } from "./allocation-selection";
import { ALLOCATION_COOLDOWN_FENCE, allocationObservation, allocationState, allocationView } from "./allocation-state";
import { creationExpiry } from "./mailbox-creation-expiry";
import { bindCreationAddress, creationAddressView, remoteCreationReservation } from "./creation-address";
import type { RandomProviderMailbox } from "./providers/contracts";

interface Creation { request_hash: string; mailbox_id: string; state: string; error_code: string | null; provider_id: string | null; address: string }

export function requireMailWrite(request: Request, env: Env, identity: Identity): void {
  requireWriteScope(request, env, identity, "mailboxes:write");
}

async function replay(env: Env, identity: Identity, row: Creation, hash: string): Promise<Response> {
  if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict");
  if (row.state !== "complete") return json({ creation: { mailboxId: row.mailbox_id,
    state: row.state, error: row.error_code, providerId: row.provider_id, ...creationAddressView(row), retrySafe: false } }, 202);
  return getMailbox(env, { ...identity, scopes: [...identity.scopes, "mailboxes:read"] }, row.mailbox_id);
}

export async function createMailbox(request: Request, env: Env, identity: Identity): Promise<Response> {
  requireMailWrite(request, env, identity);
  const input = await allocationInput(await readJson(request));
  const key = request.headers.get("idempotency-key") ?? "";
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, "idempotency_key_required");
  const hash = input.hash;
  const lookup = () => env.DB.prepare(`SELECT request_hash, mailbox_id, state, error_code, provider_id, address FROM mailbox_creations
    WHERE user_id = ? AND request_key = ?`).bind(identity.userId, key).first<Creation>();
  const previous = await lookup();
  if (previous) return replay(env, identity, previous, hash);
  try { return await performAllocation(env, identity, input, key, lookup); }
  catch (error) {
    const winner = await lookup();
    if (winner) return replay(env, identity, winner, hash);
    throw error;
  }
}

async function performAllocation(env: Env, identity: Identity, input: AllocationInput, key: string, lookup: () => Promise<Creation | null>): Promise<Response> {
  const hash = input.hash;
  const retention = await readRetention(env);
  await rateLimit(env, "mailbox-create", identity.userId, MAILBOX_QUOTAS.allocationRequestsPerMinute);
  assertVault(env);
  const { config, domain, snapshot } = await selectAllocation(env, input), providerId = config.id;
  const provider = await connectProvider(env, config);
  const remoteRandom = input.prefix === undefined && !!provider.createRandom;
  const operation = input.prefix !== undefined ? provider.createCustom?.bind(provider)
    : remoteRandom ? provider.createRandom!.bind(provider) : provider.create?.bind(provider);
  if (!operation) throw new HttpError(409, input.prefix === undefined ? "allocation_unavailable" : "custom_prefix_unavailable");
  const id = crypto.randomUUID();
  const entropy = randomToken("").slice(0, 32);
  // The self-hosted admin creator caps names at 30 characters; base36 preserves all 128 random bits.
  const name = config.type === "cloudflare" ? BigInt(`0x${entropy}`).toString(36).padStart(25, "0") : entropy;
  let address = remoteRandom ? remoteCreationReservation(id, domain) : input.prefix === undefined ? `ee${name}@${domain}` : `${input.prefix}@${domain}`;
  const now = unixNow();
  const policyExpiry = retention.policy.enabled && retention.policy.mailboxDays > 0 ? now + retention.policy.mailboxDays * 86400 : null;
  let expiresAt = provider.mailboxLifetimeSeconds ? Math.min(policyExpiry ?? Infinity, now + provider.mailboxLifetimeSeconds) : policyExpiry;
  const writes = await env.DB.batch([env.DB.prepare(`INSERT INTO mailbox_creations
    (user_id, request_key, request_hash, mailbox_id, address, state, created_at, expires_at, policy_revision, provider_id, provider_revision, provider_hash)
    SELECT ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ? WHERE
      (SELECT COUNT(*) FROM mailbox_creations WHERE user_id = ?) < ${MAILBOX_QUOTAS.allocationsPerUser}
      AND NOT EXISTS (SELECT 1 FROM mailbox_creations WHERE address = ? COLLATE NOCASE)
      AND ${PROVIDER_REVISION_FENCE} AND ${RETENTION_POLICY_FENCE} AND ${ALLOCATION_COOLDOWN_FENCE}
    ON CONFLICT(user_id, request_key) DO NOTHING`)
    .bind(identity.userId, key, hash, id, address, now, expiresAt, retention.revision, providerId, config.revision, snapshot.config_hash,
      identity.userId, address, config.id, config.revision, retention.revision, config.id, config.revision, snapshot.config_hash),
    env.DB.prepare(`UPDATE provider_allocation_state SET allocation_count=allocation_count+1 WHERE provider_id=?
      AND EXISTS (SELECT 1 FROM mailbox_creations WHERE mailbox_id=?)`).bind(providerId, id)]);
  if (!writes[0].meta.changes) {
    const duplicate = await lookup();
    if (duplicate) return replay(env, identity, duplicate, hash);
    if (await env.DB.prepare('SELECT 1 FROM mailbox_creations WHERE address = ? COLLATE NOCASE').bind(address).first()) {
      throw new HttpError(409, 'mailbox_address_unavailable');
    }
    await assertProviderRevision(env, config);
    if ((await readRetention(env)).revision !== retention.revision) throw new HttpError(409, "retention_policy_changed");
    if (!allocationView(await allocationState(env, config)).available) throw new HttpError(409, "provider_cooling");
    throw new HttpError(409, "mailbox_allocation_limit");
  }
  let providerFailure: unknown = null;
  try {
    const remote = await operation(remoteRandom ? domain : address).catch((error) => { providerFailure = error; throw error; });
    if (remoteRandom) address = await bindCreationAddress(env, identity.userId, id, address, (remote as RandomProviderMailbox).address);
    expiresAt = creationExpiry(expiresAt, remote.expiresAt);
    const context = { id, user_id: identity.userId, provider_id: providerId };
    const encrypted = await encryptCredential(env, context, remote.credential);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO mailboxes
        (id, user_id, provider_id, remote_id, address, status, created_at, credential_cipher, expires_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`).bind(id, identity.userId, providerId, remote.remoteId, address, now, encrypted, expiresAt),
      env.DB.prepare(`UPDATE mailbox_creations SET state = 'complete', expires_at = ? WHERE user_id = ? AND request_key = ? AND mailbox_id = ?`)
        .bind(expiresAt, identity.userId, key, id),
      allocationObservation(env, snapshot)!,
    ]);
    return json({ mailbox: { id, providerId, address, status: "active", createdAt: now,
      displayName: "", note: "", favorite: false, paused: false, disabled: false, disabledAt: null, releasedAt: null,
      expiresAt, expiredAt: null, expired: expiresAt !== null && expiresAt <= unixNow(),
      syncedAt: null, syncError: null, nextPage: null } }, 201);
  } catch (error) {
    // Also covers a successful upstream write followed by a D1 failure. Never silently replay that write.
    const code = error instanceof HttpError ? error.code : "creation_storage_failed";
    const observation = providerFailure ? allocationObservation(env, snapshot, providerFailure) : null;
    await env.DB.batch([env.DB.prepare(`UPDATE mailbox_creations SET state = 'unknown', error_code = ?
      WHERE user_id = ? AND request_key = ? AND state = 'pending'`).bind(code, identity.userId, key), ...(observation ? [observation] : [])]);
    const stored = await lookup();
    if (!stored) throw new HttpError(503, "creation_storage_failed");
    return replay(env, identity, stored, hash);
  }
}

import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { remoteFlagContext, remoteFlagMessage } from "./normal-remote-flags-target";
import { normalInboxSourceHash } from "./normal-inbox-claim";
import { imapEndpoint } from "./normal-account-input";
import { normalMailAuthentication } from "./normal-mail-authentication";
import { normalContext } from "./normal-account-store";
import { writeImapFlag } from "./normal-imap-client";
import { rateLimit } from "./rate-limits";
import { tokenHash } from "./security";
import { remoteFlagInput, remoteFlagKey } from "./normal-remote-flags-input";
import { assertRemoteFlagReplay, dispatchRemoteFlag, finishRemoteFlag, latestRemoteFlag, remoteFlagByKey, remoteFlagView, reserveRemoteFlag } from "./normal-remote-flags-store";

function requireRemoteFlagScopes(identity: Identity) {
  for (const scope of ["mail-accounts:read", "messages:read", "mail-accounts:remote-flags"]) requireScope(identity, scope);
}
export async function getRemoteFlagOperation(env: Env, identity: Identity, accountId: string, key: string, folderId = "") {
  requireRemoteFlagScopes(identity); remoteFlagKey(key);
  const row = await remoteFlagByKey(env, identity.userId, key);
  if (!row || row.account_id !== accountId || (row.server_folder_id ?? "") !== folderId) throw new HttpError(404, "not_found");
  return json({ operation: remoteFlagView(row) });
}
export async function normalRemoteFlags(request: Request, env: Env, identity: Identity, accountId: string, messageId: string, folderId = "") {
  requireRemoteFlagScopes(identity);
  if (request.method === "GET") {
    const context = await remoteFlagContext(env, identity, accountId, folderId); await remoteFlagMessage(env, context, messageId);
    const row = await latestRemoteFlag(env, identity.userId, accountId, messageId);
    return json({ operation: row && (row.server_folder_id ?? "") === folderId ? remoteFlagView(row) : null });
  }
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  requireWriteScope(request, env, identity, "mail-accounts:remote-flags");
  const key = remoteFlagKey(request.headers.get("idempotency-key") ?? ""), input = remoteFlagInput(await readJson(request));
  const hash = await tokenHash(JSON.stringify(folderId ? ["normal-folder-remote-flags-v1", accountId, folderId, messageId, input] : [accountId, messageId, input]));
  const existing = await remoteFlagByKey(env, identity.userId, key);
  if (existing) { assertRemoteFlagReplay(existing, hash); return json({ operation: remoteFlagView(existing) }); }
  const context = await remoteFlagContext(env, identity, accountId, folderId), account = context.account;
  if (account.revision !== input.expectedRevision || context.epochId !== input.epochId) throw new HttpError(409, "remote_flags_target_changed");
  if (!account.enabled) throw new HttpError(409, "normal_account_disabled");
  const message = await remoteFlagMessage(env, context, messageId), endpoint = await imapEndpoint(env, account.endpoint_id);
  if (endpoint.hash !== account.endpoint_hash) throw new HttpError(409, "imap_endpoint_changed");
  await rateLimit(env, "normal-remote-flags", identity.userId, 30); await rateLimit(env, "normal-remote-flags-global", "platform", 120);
  const reservation = await reserveRemoteFlag(env, context, message, context.serverFolder?.sourceHash ?? await normalInboxSourceHash(account), key, hash, input, identity);
  if (!reservation.execute) return json({ operation: remoteFlagView(reservation.row) });
  let flags: string[] | null = null, failure: string | null = null;
  try {
    const credential = await normalMailAuthentication(env, account, account.credential_cipher, normalContext(accountId, identity.userId), endpoint, account.username);
    flags = (await writeImapFlag(endpoint, account.username, credential.authentication,
      { uid: message.uid, uidValidity: message.uid_validity, flag: input.flag, value: input.value },
      () => dispatchRemoteFlag(env, reservation.row, identity, credential.fence), reservation.row.server_wire_name ?? "INBOX")).flags;
  } catch (error) { failure = error instanceof HttpError ? error.code : "remote_flags_outcome_unknown"; }
  const result = remoteFlagView(await finishRemoteFlag(env, reservation.row, flags, failure));
  return json({ operation: result }, result.state === "unknown" || result.state === "pending" ? 202 : 201);
}

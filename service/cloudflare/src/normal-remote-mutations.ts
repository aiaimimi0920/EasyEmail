import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { remoteFlagContext, remoteFlagMessage } from "./normal-remote-flags-target";
import { normalInboxSourceHash } from "./normal-inbox-claim";
import { imapEndpoint } from "./normal-account-input";
import { normalMailAuthentication } from "./normal-mail-authentication";
import { normalContext } from "./normal-account-store";
import { writeImapMutation } from "./normal-imap-client";
import type { ImapMutationResult } from "./normal-imap-mutations";
import { rateLimit } from "./rate-limits";
import { tokenHash } from "./security";
import { remoteMutationInput, remoteMutationKey } from "./normal-remote-mutation-input";
import { assertRemoteMutationReplay, latestRemoteMutation, remoteMutationByKey, remoteMutationView } from "./normal-remote-mutation-model";
import { mutationDestination, mutationScope } from "./normal-remote-mutation-target";
import { dispatchRemoteMutation, finishRemoteMutation, recordRemoteMutationDestination, reserveRemoteMutation } from "./normal-remote-mutation-store";
import { requireRemoteMutationSchema } from "./normal-remote-write-barrier";

function requireMutationRead(identity: Identity) {
  requireScope(identity, "mail-accounts:read"); requireScope(identity, "messages:read");
  if (identity.kind === "apiKey" && !["move", "delete"].some(action => identity.scopes.includes(`mail-accounts:remote-${action}`))) {
    throw new HttpError(403, "insufficient_scope");
  }
}
export async function getRemoteMutationOperation(env: Env, identity: Identity, accountId: string, key: string, folderId = "") {
  requireMutationRead(identity); remoteMutationKey(key); await requireRemoteMutationSchema(env);
  const row = await remoteMutationByKey(env, identity.userId, key);
  if (!row || row.account_id !== accountId || (row.server_folder_id ?? "") !== folderId) throw new HttpError(404, "not_found");
  requireScope(identity, mutationScope(row.action)); return json({ operation: remoteMutationView(row) });
}
export async function normalRemoteMutations(request: Request, env: Env, identity: Identity, accountId: string, messageId: string, folderId = "") {
  requireMutationRead(identity);
  if (request.method === "GET") {
    await requireRemoteMutationSchema(env);
    const row = await latestRemoteMutation(env, identity.userId, accountId, messageId);
    if (row && (row.server_folder_id ?? "") === folderId) {
      requireScope(identity, mutationScope(row.action)); return json({ operation: remoteMutationView(row) });
    }
    const context = await remoteFlagContext(env, identity, accountId, folderId); await remoteFlagMessage(env, context, messageId);
    return json({ operation: null });
  }
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  const key = remoteMutationKey(request.headers.get("idempotency-key") ?? ""), input = remoteMutationInput(await readJson(request));
  requireWriteScope(request, env, identity, mutationScope(input.action)); await requireRemoteMutationSchema(env);
  const hash = await tokenHash(JSON.stringify(["normal-remote-mutation-v1", accountId, folderId, messageId, input]));
  const existing = await remoteMutationByKey(env, identity.userId, key);
  if (existing) { assertRemoteMutationReplay(existing, hash); return json({ operation: remoteMutationView(existing) }); }
  const context = await remoteFlagContext(env, identity, accountId, folderId), account = context.account;
  if (account.revision !== input.expectedRevision || context.epochId !== input.epochId) throw new HttpError(409, "remote_mutation_target_changed");
  if (!account.enabled) throw new HttpError(409, "normal_account_disabled");
  const message = await remoteFlagMessage(env, context, messageId), endpoint = await imapEndpoint(env, account.endpoint_id);
  if (endpoint.hash !== account.endpoint_hash) throw new HttpError(409, "imap_endpoint_changed");
  const destination = input.action === "move" ? await mutationDestination(env, identity, accountId, input.destinationFolderId, input.destinationEpochId) : null;
  if (destination?.destination_wire_name === (context.serverFolder?.wireName ?? "INBOX")) throw new HttpError(400, "invalid_remote_mutation_request");
  await rateLimit(env, "normal-remote-mutations", identity.userId, 30); await rateLimit(env, "normal-remote-mutations-global", "platform", 120);
  const reservation = await reserveRemoteMutation(env, context, message, context.serverFolder?.sourceHash ?? await normalInboxSourceHash(account), destination, key, hash, input, identity);
  if (!reservation.execute) return json({ operation: remoteMutationView(reservation.row) });
  let result: ImapMutationResult | null = null, failure: string | null = null;
  try {
    const credential = await normalMailAuthentication(env, account, account.credential_cipher, normalContext(accountId, identity.userId), endpoint, account.username);
    result = await writeImapMutation(endpoint, account.username, credential.authentication,
      { uid: message.uid, uidValidity: message.uid_validity, action: input.action },
      (phase, mapping, validity) => dispatchRemoteMutation(env, reservation.row, identity, credential.fence, phase, mapping, validity),
      reservation.row.server_wire_name ?? "INBOX", reservation.row.destination_wire_name ?? undefined,
      mapping => recordRemoteMutationDestination(env, reservation.row, mapping));
  } catch (error) { failure = error instanceof HttpError ? error.code : "remote_mutation_outcome_unknown"; }
  const operation = remoteMutationView(await finishRemoteMutation(env, reservation.row, result, failure));
  return json({ operation }, operation.state === "unknown" || operation.state === "pending" ? 202 : 201);
}

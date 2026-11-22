import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { identityCredentialFence } from "./identity";
import { folderInboxContext } from "./normal-folder-inbox-access";
import { normalInboxSourceHash } from "./normal-inbox-claim";
import type { RemoteMutationOperation } from "./normal-remote-mutation-model";

export type MutationDestination = Pick<RemoteMutationOperation, "destination_folder_id" | "destination_wire_name" | "destination_catalog_source"
  | "destination_source_hash" | "destination_epoch_id" | "destination_uid_validity" | "destination_cache_generation">;
export const mutationScope = (action: "move" | "delete") => `mail-accounts:remote-${action}`;
export function mutationCredentialFence(identity: Identity, action: "move" | "delete") {
  const scopes = ["mail-accounts:read", "messages:read", mutationScope(action)];
  return { sql: `${identityCredentialFence(identity)}${identity.kind === "apiKey" ? scopes.map(() =>
    " AND EXISTS (SELECT 1 FROM api_keys k,json_each(k.scopes) j WHERE k.id=? AND j.value=?)").join("") : ""}`,
    values: [identity.credentialId, identity.userId, ...(identity.kind === "apiKey" ? scopes.flatMap(scope => [identity.credentialId, scope]) : [])] };
}
export async function mutationDestination(env: Env, identity: Identity, accountId: string, folderId: string, epochId: string): Promise<MutationDestination> {
  const context = await folderInboxContext(env, identity, accountId, folderId), folder = context.serverFolder!;
  const inbox = folder.wireName === "INBOX", table = inbox ? "normal_inbox_state" : "normal_server_folder_state";
  const sourceHash = inbox ? await normalInboxSourceHash(context.account) : folder.sourceHash;
  const state = await env.DB.prepare(`SELECT uid_validity FROM ${table} WHERE account_id=? AND source_hash=? AND epoch_id=?
    AND cache_generation=?${inbox ? "" : " AND server_folder_id=? AND wire_name=?"}`)
    .bind(accountId, sourceHash, epochId, context.cacheGeneration, ...(inbox ? [] : [folderId, folder.wireName])).first<{ uid_validity: string | null }>();
  if (context.epochId !== epochId || !state?.uid_validity) throw new HttpError(409, "remote_mutation_destination_sync_required");
  return { destination_folder_id: folderId, destination_wire_name: folder.wireName, destination_catalog_source: folder.catalogSource,
    destination_source_hash: sourceHash, destination_epoch_id: epochId, destination_uid_validity: state.uid_validity,
    destination_cache_generation: context.cacheGeneration };
}
export function mutationDestinationFence(row: RemoteMutationOperation) {
  if (row.action === "delete") return { sql: "1", values: [] };
  const inbox = row.destination_wire_name === "INBOX", table = inbox ? "normal_inbox_state" : "normal_server_folder_state";
  return { sql: `EXISTS (SELECT 1 FROM normal_server_folder_catalogs c,json_each(c.folders) j WHERE c.account_id=?
    AND c.source_hash=? AND json_extract(j.value,'$.id')=? AND json_extract(j.value,'$.wireName')=? AND json_extract(j.value,'$.selectable')=1)
    AND EXISTS (SELECT 1 FROM ${table} s WHERE s.account_id=? AND s.source_hash=? AND s.epoch_id=?
    AND s.uid_validity=? AND s.cache_generation=?${inbox ? "" : " AND s.server_folder_id=? AND s.wire_name=?"})`,
    values: [row.account_id, row.destination_catalog_source!, row.destination_folder_id!, row.destination_wire_name!,
      row.account_id, row.destination_source_hash!, row.destination_epoch_id!, row.destination_uid_validity!,
      row.destination_cache_generation!, ...(inbox ? [] : [row.destination_folder_id!, row.destination_wire_name!])] };
}

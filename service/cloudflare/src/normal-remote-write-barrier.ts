import type { Env } from "./contracts";
import { HttpError } from "./http";
import type { RemoteMessageTarget } from "./normal-remote-flags-target";

export async function requireRemoteMutationSchema(env: Env) {
  const row = await env.DB.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE
    (type='table' AND name='normal_remote_mutation_operations') OR (type='index' AND name='normal_remote_mutation_target')
    OR (type='trigger' AND name IN ('normal_remote_mutation_excludes_flags','normal_remote_flags_exclude_mutation_insert','normal_remote_flags_exclude_mutation_dispatch'))`).first<{ n: number }>();
  if (row?.n !== 5) throw new HttpError(409, "remote_mutation_schema_required");
}
export async function mutationBlocksRemoteWrite(env: Env, row: RemoteMessageTarget) {
  if (!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='normal_remote_mutation_operations'").first()) return false;
  return !!await env.DB.prepare(`SELECT 1 FROM normal_remote_mutation_operations WHERE account_id=?
    AND COALESCE(server_wire_name,'INBOX')=? AND uid_validity=? AND uid=? AND state<>'failed' LIMIT 1`)
    .bind(row.account_id, row.server_wire_name ?? "INBOX", row.uid_validity, row.uid).first();
}
export async function flagsBlockMutation(env: Env, row: RemoteMessageTarget) {
  // A later confirmed flag cannot cancel an older dispatched STORE that may still arrive.
  return !!await env.DB.prepare(`SELECT 1 FROM normal_remote_flag_operations WHERE account_id=?
    AND COALESCE(server_wire_name,'INBOX')=? AND uid_validity=? AND uid=? AND state IN ('pending','unknown') LIMIT 1`)
    .bind(row.account_id, row.server_wire_name ?? "INBOX", row.uid_validity, row.uid).first();
}

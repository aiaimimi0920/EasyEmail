import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { draftRevision, UUID } from "./draft-input";
import { draftRow } from "./draft-store";
import { draftSourceMatches, draftSourceScope } from "./draft-source";

export interface DraftSend { id: string; revision: number }
export function draftSendInput(body: Record<string, unknown>): DraftSend | null {
  if (body.draftId === undefined && body.draftRevision === undefined) return null;
  if (typeof body.draftId !== "string" || !UUID.test(body.draftId)) throw new HttpError(400, "invalid_draft_request");
  return { id: body.draftId, revision: draftRevision(body.draftRevision, false) };
}

export async function assertDraftSend(env: Env, identity: Identity, draft: DraftSend | null, hash: string, accountId?: string): Promise<void> {
  if (!draft) return;
  const row = await draftRow(env, identity, draft.id);
  if (!row || !draftSourceMatches(row, accountId)) throw new HttpError(404, "not_found");
  if (row.state === "submitted") throw new HttpError(409, "draft_submitted");
  if (row.state !== "editing" || row.revision !== draft.revision || row.content_hash !== hash) throw new HttpError(409, "draft_changed");
}

export function draftSendFence(identity: Identity, draft: DraftSend | null, hash: string, accountId?: string) {
  const scope = draftSourceScope(accountId);
  return draft ? {
    sql: `EXISTS (SELECT 1 FROM drafts WHERE user_id=? AND id=? AND revision=? AND content_hash=? AND state='editing' AND ${scope.sql})`,
    values: [identity.userId, draft.id, draft.revision, hash, ...scope.values],
  } : { sql: "1", values: [] };
}

export async function reserveDraftSend(env: Env, identity: Identity, draft: DraftSend | null, outgoingId: string, statement: D1PreparedStatement, accountId?: string) {
  if (!draft) return statement.run();
  const table = accountId ? "normal_outgoing_messages" : "outgoing_messages", scope = draftSourceScope(accountId);
  // The conditional reservation and consumption share one D1 transaction. There is no external call inside it.
  const results = await env.DB.batch([statement, env.DB.prepare(`UPDATE drafts SET state='submitted',revision=revision+1,outgoing_id=?,updated_at=unixepoch()
    WHERE user_id=? AND id=? AND revision=? AND state='editing'
    AND ${scope.sql} AND EXISTS (SELECT 1 FROM ${table} WHERE id=? AND user_id=?)`)
    .bind(outgoingId, identity.userId, draft.id, draft.revision, ...scope.values, outgoingId, identity.userId)]);
  if (results[0].meta.changes && !results[1].meta.changes) throw new HttpError(500, "draft_storage_failed");
  return results[0];
}

import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { normalContent } from "./normal-inbox-objects";
import type { NormalStoredMessage } from "./normal-inbox-access";
import { assertNormalSearchCurrent, normalProjection, normalSearchJoin, normalSearchVisible, type NormalSearchContext } from "./normal-search-index";
import { normalThreadStatements } from "./normal-thread-store";
import { identityCredentialFence } from "./identity";

export async function ensureNormalConversations(env: Env, identity: Identity, contexts: NormalSearchContext[], accountId = "") {
  if (!contexts.length) return;
  const sql = `SELECT m.* FROM normal_inbox_messages m ${normalSearchJoin(contexts)}
    WHERE ${normalSearchVisible} AND m.thread_version=0 ORDER BY m.id LIMIT 6`;
  const bindings = [JSON.stringify(contexts), identity.userId];
  const rows = (await env.DB.prepare(sql).bind(...bindings).all<NormalStoredMessage>()).results, statements = [];
  for (const row of rows.slice(0, 5)) {
    const content = await normalContent(env, row);
    const fence = `EXISTS (SELECT 1 FROM normal_inbox_messages m ${normalSearchJoin(contexts)} WHERE ${normalSearchVisible} AND m.id=?) AND ${identityCredentialFence(identity)}`;
    const values = [...bindings, row.id, identity.credentialId, identity.userId];
    statements.push(normalProjection(env, row.id, row.content_sha256, content, fence, values));
    statements.push(...await normalThreadStatements(env, identity.userId, row.account_id, row.epoch_id,
      { where: `m.id=? AND ${fence}`, values: [row.id, ...values] }, content));
  }
  if (statements.length) await env.DB.batch(statements);
  await assertNormalSearchCurrent(env, identity, contexts, accountId);
  if ((await env.DB.prepare(sql).bind(...bindings).all()).results.length) throw new HttpError(409, "normal_conversation_index_pending");
}

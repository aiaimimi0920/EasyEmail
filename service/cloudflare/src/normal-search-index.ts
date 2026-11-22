import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import type { NormalMimeContent } from "./normal-mime-content";
import { normalContent } from "./normal-inbox-objects";
import type { NormalStoredMessage } from "./normal-inbox-access";
import { identityCredentialFence } from "./identity";
import { normalSearchContexts, normalSearchJoin, normalSearchVisible, type NormalSearchContext, type NormalSearchScope } from "./normal-search-context";
export { normalSearchContexts, normalSearchJoin, normalSearchVisible, normalSearchSourceColumns, type NormalSearchContext } from "./normal-search-context";
export function normalProjection(env: Env, id: string, digest: string, content: NormalMimeContent, fence: string, values: (string | number)[]) {
  return env.DB.prepare(`INSERT INTO normal_inbox_search(message_id,content_sha256,sender,recipient,subject,text_body,html_body)
    SELECT ?,?,?,?,?,?,? WHERE ${fence} ON CONFLICT(message_id) DO UPDATE SET content_sha256=excluded.content_sha256,
    sender=excluded.sender,recipient=excluded.recipient,subject=excluded.subject,text_body=excluded.text_body,html_body=excluded.html_body`)
    .bind(id, digest, content.sender, content.headerRecipient ?? content.recipient, content.subject, content.textBody, content.htmlBody, ...values);
}
export async function assertNormalSearchCurrent(env: Env, identity: Identity, contexts: NormalSearchContext[], accountId = "", scope: NormalSearchScope = "all") {
  if (!await env.DB.prepare(`SELECT 1 WHERE ${identityCredentialFence(identity)}`).bind(identity.credentialId, identity.userId).first()) throw new HttpError(401, "unauthorized");
  if (JSON.stringify(await normalSearchContexts(env, identity, accountId, scope)) !== JSON.stringify(contexts)) throw new HttpError(409, "normal_account_changed");
}
export async function ensureNormalSearch(env: Env, identity: Identity, contexts: NormalSearchContext[], accountId = "", scope: NormalSearchScope = "all") {
  if (!contexts.length) return;
  const sql = `SELECT m.* FROM normal_inbox_messages m ${normalSearchJoin(contexts)}
    LEFT JOIN normal_inbox_search p ON p.message_id=m.id AND p.content_sha256=m.content_sha256
    WHERE ${normalSearchVisible} AND p.message_id IS NULL ORDER BY m.id LIMIT 6`;
  const bindings = [JSON.stringify(contexts), identity.userId];
  const rows = (await env.DB.prepare(sql).bind(...bindings).all<NormalStoredMessage>()).results, statements = [];
  for (const row of rows.slice(0, 5)) {
    const content = await normalContent(env, row);
    const fence = `EXISTS (SELECT 1 FROM normal_inbox_messages m ${normalSearchJoin(contexts)} WHERE ${normalSearchVisible} AND m.id=?) AND ${identityCredentialFence(identity)}`;
    statements.push(normalProjection(env, row.id, row.content_sha256, content, fence, [...bindings, row.id, identity.credentialId, identity.userId]));
  }
  if (statements.length) await env.DB.batch(statements);
  await assertNormalSearchCurrent(env, identity, contexts, accountId, scope);
  if ((await env.DB.prepare(sql).bind(...bindings).all()).results.length) throw new HttpError(409, "normal_index_pending");
}

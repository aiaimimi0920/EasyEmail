import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { requireScope } from "./identity";
import { attachmentDisposition, downloadable } from "./attachment-policy";
import { agentInboxContext, agentIncomingMessage, assertAgentInboxCurrent } from "./agent-inbox-access";
import { normalContent, normalObject } from "./normal-inbox-objects";
import { normalMimeHash, parseNormalMimeParts } from "./normal-mime-content";
import { rateLimit } from "./rate-limits";

export async function downloadAgentIncoming(env: Env, identity: Identity, accountId: string, id: string, index: number | null) {
  requireScope(identity, "attachments:read");
  const context = await agentInboxContext(env, identity, accountId), row = await agentIncomingMessage(env, context, id);
  if (index !== null && (!Number.isInteger(index) || index < 0 || index > 99)) throw new HttpError(404, "not_found");
  const content = index === null ? null : await normalContent(env, row), expected = index === null ? null : content!.attachments[index];
  if (content && content.recipient !== context.account.email_address) throw new HttpError(503, "agent_content_unavailable");
  if (index !== null && (!expected || !downloadable(expected))) throw new HttpError(404, "not_found");
  await rateLimit(env, "attachment-download", identity.userId, 10); await rateLimit(env, "attachment-download-global", "platform", 100);
  const raw = await normalObject(env, row.raw_key, row.raw_bytes, row.raw_sha256);
  let bytes = raw, filename = "message.eml";
  if (expected) {
    const parsed = await parseNormalMimeParts(raw), part = parsed.attachments[index!];
    if (!part || typeof part.content === "string") throw new HttpError(409, "attachment_source_changed");
    bytes = new Uint8Array(part.content);
    if (bytes.length !== expected.size || await normalMimeHash(bytes) !== expected.sha256) throw new HttpError(409, "attachment_source_changed");
    filename = expected.filename;
  }
  await assertAgentInboxCurrent(env, identity, context); await agentIncomingMessage(env, context, id);
  return new Response(new Uint8Array(bytes).buffer, { headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length),
    "content-disposition": attachmentDisposition(filename) } });
}

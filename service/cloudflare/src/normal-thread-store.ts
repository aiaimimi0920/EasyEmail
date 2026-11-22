import type { Env } from "./contracts";
import { HttpError } from "./http";
import { rfcMessageId } from "./mail-address";
import { messageThreadPlan, parseThreadHeaders } from "./message-thread-input";
import type { NormalMimeContent } from "./normal-mime-content";
import { graphWriteStatements, type ThreadTarget } from "./thread-graph-store";

export async function normalThreadPlan(content: NormalMimeContent) {
  const headers = content.threadHeaders;
  if (content.rfcMessageId !== undefined && content.rfcMessageId !== null &&
    (typeof content.rfcMessageId !== "string" || !rfcMessageId(content.rfcMessageId))) throw new HttpError(503, "normal_content_unavailable");
  let threadHeaders;
  if (headers !== undefined) {
    if (!headers || typeof headers !== "object" || Array.isArray(headers) || typeof headers.limited !== "boolean") throw new HttpError(503, "normal_content_unavailable");
    for (const [values, max] of [[headers.inReplyTo, 4], [headers.references, 27]] as const) {
      if (!Array.isArray(values) || values.length > max || values.some(value => typeof value !== "string" || !rfcMessageId(value))) throw new HttpError(503, "normal_content_unavailable");
    }
    threadHeaders = parseThreadHeaders({ version: 1, inReplyTo: headers.inReplyTo.join(" "), references: headers.references.join(" "), limited: headers.limited });
  }
  return messageThreadPlan({ ...content, threadHeaders });
}
export async function normalThreadStatements(env: Env, userId: string, accountId: string, epochId: string, target: ThreadTarget, content: NormalMimeContent) {
  return graphWriteStatements(env, { messages: "normal_inbox_messages", links: "normal_thread_links", alive: "m.purged_at IS NULL",
    messageScope: "m.account_id=? AND m.epoch_id=?", messageValues: [accountId, epochId],
    linkOwner: { user_id: userId, account_id: accountId, epoch_id: epochId } }, target, await normalThreadPlan(content));
}

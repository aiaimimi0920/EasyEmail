import type { Env } from "./contracts";
import type { ThreadPlan } from "./message-thread-model";
import { graphWriteStatements, type ThreadTarget } from "./thread-graph-store";

export type { ThreadTarget } from "./thread-graph-store";
export function threadWriteStatements(env: Env, userId: string, mailboxId: string, target: ThreadTarget, plan: ThreadPlan) {
  return graphWriteStatements(env, { messages: "messages", links: "message_thread_links", alive: "m.purged_at IS NULL",
    messageScope: "m.user_id=? AND m.mailbox_id=?", messageValues: [userId, mailboxId], linkOwner: { user_id: userId, mailbox_id: mailboxId } }, target, plan);
}

import type { OutboxAttachment } from "./outbox-attachments";
import { sendState, type Outgoing } from "./outgoing";

export interface SendJob {
  id: string; mailboxId?: string; accountId?: string; accountRevision?: number; smtpRevision?: number;
  requestKey: string; revision: number; state: Outgoing["state"] | "queued" | "preparing" | "cancelled" | "failed"; error: string | null;
  scheduledAt: number | null; dueAt: number; deadlineAt: number; nextAttemptAt: number;
  attempts: number; manualRetries: number; outgoingId: string | null; cancellable: boolean; retrySafe: boolean;
  subject: string; draftId: string | null; createdAt: number; updatedAt: number; contentPurgedAt: number | null;
  content?: { to: string | string[]; cc: string[]; bcc: string[]; subject: string; text: string; replyToMessageId: string | null; attachments: OutboxAttachment[] } | null;
}
export function jobState(state: SendJob["state"]) {
  switch (state) {
    case "queued": return "已加入发送队列";
    case "preparing": return "正在准备发送";
    case "cancelled": return "已取消";
    case "failed": return "准备失败，尚未派发";
    default: return sendState(state);
  }
}

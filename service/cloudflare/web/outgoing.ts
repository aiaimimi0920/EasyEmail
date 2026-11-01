import type { OutboxAttachment } from "./outbox-attachments";
export interface Outgoing {
  id: string; mailboxId: string; requestKey: string; from: string; to: string | string[]; cc?: string[]; bcc?: string[]; subject: string; text?: string;
  state: "pending" | "accepted" | "rejected" | "unknown"; error: string | null;
  threading: string; createdAt: number; contentPurgedAt: number | null;
  attachments?: OutboxAttachment[];
}

export const sendState = (state: Outgoing["state"]) => ({
  pending: "发送处理中", accepted: "渠道已接受（未确认送达）", rejected: "渠道已拒绝", unknown: "发送结果未知，请勿重复发送",
})[state];

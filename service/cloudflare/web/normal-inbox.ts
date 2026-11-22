import { api, ApiError, type Attachment, type Page, type MessageSummary } from "./api";

export interface NormalMailSummary {
  id: string; accountId: string; epochId: string; uid: number; sender: string; recipient: string; subject: string;
  receivedAt: number; observedAt: number; remoteFlags: string[]; serverFolderId?: string; serverFolderName?: string;
  platformState: { isRead: boolean; starred: boolean; archived: boolean; trashedAt: number | null };
}
export interface NormalMail extends NormalMailSummary { accountRevision: number; textBody: string; htmlBody: string; attachments: Attachment[]; attachmentsTruncated: boolean }
export interface NormalAggregateSummary extends NormalMailSummary { sourceKind: "normal"; mailboxAddress: string; mailboxDisplayName: string }
export type UnifiedMessageSummary = MessageSummary | NormalAggregateSummary;
export interface NormalMailPage extends Page<NormalMailSummary> { epochId: string | null; accountRevision: number; sourceReady: boolean }
export interface NormalSyncRequest {
  id: string; accountId: string; requestKey: string; serverFolderId?: string; accountRevision: number; state: "pending" | "committed" | "failed";
  createdAt: number; finishedAt: number | null; errorCode: string | null;
  result: { stored: number; skipped: { uid: number; reason: string }[]; complete: boolean; reset: boolean;
    cursor: { uidValidity: string; afterUid: number } } | null;
}
export const normalInboxPath = (id: string, serverFolderId = "") => `/normal-accounts/${id}${serverFolderId ? `/server-folders/${serverFolderId}` : ""}`;
export const normalMessagePath = (message: Pick<NormalMailSummary, "accountId" | "id" | "serverFolderId">) =>
  `${normalInboxPath(message.accountId, message.serverFolderId)}/messages/${message.id}`;
export const normalMessages = (id: string, cursor = "", signal?: AbortSignal, folder = "inbox", folderId = "", serverFolderId = "") => api<NormalMailPage>(
  `${normalInboxPath(id)}${serverFolderId ? `/server-folders/${serverFolderId}` : ""}/messages?${serverFolderId ? "limit=20" : `folder=${folder}${folderId ? `&folderId=${encodeURIComponent(folderId)}` : ""}`}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  "GET", undefined, undefined, signal);
export async function downloadNormalRaw(path: string, signal: AbortSignal) {
  const response = await fetch(`/api/v1${path}/raw`, { credentials: "same-origin", redirect: "error", cache: "no-store", signal });
  if (!response.ok) { const value = await response.json(); throw new ApiError(response.status, value.error?.code ?? "request_failed"); }
  if (response.headers.get("content-type") !== "application/octet-stream" || Number(response.headers.get("content-length")) > 2097152) throw new Error("invalid raw response");
  const blob = await response.blob(); if (signal.aborted) return;
  if (blob.size > 2097152 || blob.size !== Number(response.headers.get("content-length"))) throw new Error("invalid raw size");
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  try { link.href = url; link.download = "message.eml"; link.hidden = true; document.body.append(link); link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

import { ApiError } from "./api";

export type RemoteMutationBody = { expectedRevision: number; epochId: string } & (
  { action: "move"; destinationFolderId: string; destinationEpochId: string; confirmRemoteChange: true }
  | { action: "delete"; confirmPermanentDelete: true });
export interface RemoteMutationAttempt {
  accountId: string; messageId: string; serverFolderId?: string; uid: number; key: string; body: RemoteMutationBody;
  sourceName: string; subject: string; destinationName?: string;
}
export interface RemoteMutationOperation {
  id: string; accountId: string; messageId: string; serverFolderId?: string; accountRevision: number; epochId: string;
  uid: number; uidValidity: string; requestKey: string; action: "move" | "delete";
  state: "pending" | "confirmed" | "failed" | "unknown"; phase: "move" | "copy" | "mark-deleted" | "expunge" | null;
  method: "move" | "copy-expunge" | "delete" | null; sourceRemoved: boolean;
  destinationFolderId: string | null; destinationEpochId: string | null; destination: { uidValidity: string; uid: number } | null;
  error: string | null; retrySafe: false; cacheRetained: true;
  createdAt: number; dispatchedAt: number | null; phaseAt: number | null; finishedAt: number | null;
}
const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const folder = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const uid = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 4294967295;
const validity = (value: unknown) => typeof value === "string" && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 4294967295;
const time = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
export function checkedRemoteMutation(value: unknown, accountId: string, messageId: string,
  attempt?: RemoteMutationAttempt, serverFolderId = attempt?.serverFolderId ?? ""): RemoteMutationOperation {
  const row = value as RemoteMutationOperation | null;
  if (!row || typeof row !== "object" || !uuid(row.id) || row.accountId !== accountId || row.messageId !== messageId || !uuid(row.epochId)
    || (row.serverFolderId !== undefined && !folder(row.serverFolderId)) || (row.serverFolderId ?? "") !== serverFolderId
    || !Number.isSafeInteger(row.accountRevision) || row.accountRevision < 1 || !uid(row.uid) || !validity(row.uidValidity)
    || typeof row.requestKey !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(row.requestKey)
    || !["move", "delete"].includes(row.action) || !["pending", "confirmed", "failed", "unknown"].includes(row.state)
    || ![null, "move", "copy", "mark-deleted", "expunge"].includes(row.phase) || ![null, "move", "copy-expunge", "delete"].includes(row.method)
    || typeof row.sourceRemoved !== "boolean" || row.retrySafe !== false || row.cacheRetained !== true
    || (row.error !== null && (typeof row.error !== "string" || !row.error || row.error.length > 128))
    || !time(row.createdAt) || [row.dispatchedAt, row.phaseAt, row.finishedAt].some(value => value !== null && (!time(value) || value < row.createdAt))
    || (row.phase === null) !== (row.dispatchedAt === null) || (row.phase === null) !== (row.phaseAt === null) || (row.phase === null) !== (row.method === null)
    || (row.phaseAt !== null && row.dispatchedAt !== null && row.phaseAt < row.dispatchedAt)
    || (row.finishedAt !== null && row.phaseAt !== null && row.finishedAt < row.phaseAt)
    || (row.action === "delete" ? row.destinationFolderId !== null || row.destinationEpochId !== null || row.destination !== null
      || (row.method !== null && row.method !== "delete") || (row.phase !== null && !["mark-deleted", "expunge"].includes(row.phase))
      : !folder(row.destinationFolderId) || !uuid(row.destinationEpochId) || row.method === "delete"
        || (row.method === "move" && row.phase !== "move") || (row.method === "copy-expunge" && !["copy", "mark-deleted", "expunge"].includes(row.phase!)))
    || (row.destination !== null && (!row.destination || typeof row.destination !== "object" || !uid(row.destination.uid)
      || !validity(row.destination.uidValidity) || row.dispatchedAt === null))
    || (row.state !== "confirmed" && row.sourceRemoved)
    || (row.state === "pending" && (row.finishedAt !== null || row.error !== null))
    || (row.state === "failed" && (row.dispatchedAt !== null || row.finishedAt === null || row.error === null))
    || (row.state === "unknown" && row.error === null)
    || (row.state === "confirmed" && (!row.sourceRemoved || row.error !== null || row.finishedAt === null || row.dispatchedAt === null
      || (row.action === "delete" ? row.phase !== "expunge" : row.destination === null || !["move", "expunge"].includes(row.phase!))))
    || (attempt && (row.requestKey !== attempt.key || row.accountRevision !== attempt.body.expectedRevision || row.epochId !== attempt.body.epochId
      || row.uid !== attempt.uid || row.action !== attempt.body.action || (attempt.body.action === "move"
        && (row.destinationFolderId !== attempt.body.destinationFolderId || row.destinationEpochId !== attempt.body.destinationEpochId))))) {
    throw new ApiError(502, "remote_mutation_response_invalid");
  }
  return row;
}

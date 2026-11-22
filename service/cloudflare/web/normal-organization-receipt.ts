import { ApiError } from "./api";

export function checkedNormalOrganization(value: unknown, accountId: string, serverFolderId: string | undefined, key: string, count: number) {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || row.accountId !== accountId || row.serverFolderId !== serverFolderId || row.key !== key
    || row.messageCount !== count || row.upstreamChanged !== false || typeof row.id !== "string"
    || !/^[0-9a-f-]{36}$/.test(row.id) || typeof row.epochId !== "string" || !/^[0-9a-f-]{36}$/.test(row.epochId)
    || !Number.isSafeInteger(row.accountRevision) || Number(row.accountRevision) < 1
    || !Number.isSafeInteger(row.completedAt) || Number(row.completedAt) < 1) throw new ApiError(503, "normal_organization_response_invalid");
}

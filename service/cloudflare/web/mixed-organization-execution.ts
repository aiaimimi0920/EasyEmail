import { api, ApiError, errorMessage } from "./api";
import type { OrganizationResult } from "./labels-api";
import { groupWritePath, groupReceiptPath, type OrganizationGroup } from "./mixed-organization-plan";
import { checkedNormalOrganization } from "./normal-organization-receipt";

export type OrganizationTransport = (path: string, method?: string, body?: unknown, headers?: Record<string, string>) => Promise<OrganizationResult>;
export async function executeOrganizationGroup(group: OrganizationGroup, readOnly: boolean, request: OrganizationTransport = api): Promise<OrganizationGroup> {
  try {
    const result = readOnly ? await request(groupReceiptPath(group))
      : await request(groupWritePath(group), "POST", group.body, { "idempotency-key": group.key });
    if (result.operation?.key !== group.key || result.operation.messageCount !== group.body.messageIds.length) throw new Error("整理回执不匹配，结果未确认");
    if (group.accountId) checkedNormalOrganization(result.operation, group.accountId, group.serverFolderId, group.key, group.body.messageIds.length);
    return { ...group, state: "completed", error: "" };
  } catch (failure) {
    const rejected = !readOnly && group.state !== "unknown" && failure instanceof ApiError && failure.status < 500 && failure.status !== 429;
    return { ...group, state: rejected ? "rejected" : "unknown", error: errorMessage(failure) };
  }
}
export async function executeReadyGroups(initial: OrganizationGroup[], update: (groups: OrganizationGroup[]) => void,
  alive: () => boolean, request: OrganizationTransport = api) {
  let groups = initial;
  for (const group of initial.filter(row => row.state === "ready")) {
    if (!alive()) break;
    groups = groups.map(row => row.id === group.id ? { ...row, state: "pending" } : row); update(groups);
    const result = await executeOrganizationGroup(group, false, request);
    groups = groups.map(row => row.id === group.id ? result : row);
    if (!alive()) break;
    update(groups); if (result.state !== "completed") break;
  }
  return groups;
}

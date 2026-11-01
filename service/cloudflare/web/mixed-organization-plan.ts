import type { OrganizationPatch } from "./labels-api";
import { normalInboxPath } from "./normal-inbox";

export interface OrganizationTarget { id: string; sourceKind?: "temporary" | "normal"; accountId?: string; mailboxAddress?: string; serverFolderId?: string; serverFolderName?: string }
export type GroupState = "ready" | "pending" | "unknown" | "completed" | "rejected" | "skipped";
type Body = Readonly<Omit<OrganizationPatch, "addLabelIds" | "removeLabelIds"> & {
  messageIds: readonly string[]; addLabelIds?: readonly string[]; removeLabelIds?: readonly string[];
}>;
export interface OrganizationGroup {
  id: string; name: string; accountId: string | null; serverFolderId?: string; key: string; body: Body; state: GroupState; error: string;
}
export const messageSelectionKey = (target: OrganizationTarget) => target.sourceKind === "normal"
  ? `normal:${target.accountId}:${target.serverFolderId ? `${target.serverFolderId}:` : ""}${target.id}` : `temporary:${target.id}`;
export const canOrganizeMessage = (target: OrganizationTarget) => !target.serverFolderId || (target.sourceKind === "normal" && /^[0-9a-f]{64}$/.test(target.serverFolderId));
export const unfinishedGroups = (groups: readonly OrganizationGroup[]) => groups.some(group => ["ready", "pending", "unknown"].includes(group.state));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createOrganizationPlan(targets: readonly OrganizationTarget[], patch: OrganizationPatch, key = () => crypto.randomUUID()): OrganizationGroup[] {
  if (!targets.length || targets.length > 50 || new Set(targets.map(messageSelectionKey)).size !== targets.length) throw new Error("请选择1–50封不同的邮件");
  const grouped = new Map<string, { accountId: string | null; serverFolderId?: string; name: string; ids: string[] }>();
  for (const target of targets) {
    if (!canOrganizeMessage(target)) throw new Error("服务器文件夹身份无效，请刷新列表");
    if (!UUID.test(target.id) || (target.sourceKind !== undefined && !["temporary", "normal"].includes(target.sourceKind)) ||
      (target.sourceKind === "normal" && !UUID.test(target.accountId ?? ""))) throw new Error("邮件来源无效，请刷新列表");
    const accountId = target.sourceKind === "normal" ? target.accountId! : null, serverFolderId = target.serverFolderId;
    const id = accountId ? `normal:${accountId}${serverFolderId ? `:${serverFolderId}` : ""}` : "temporary";
    let group = grouped.get(id);
    if (!group) { group = { accountId, ...(serverFolderId ? { serverFolderId } : {}),
      name: accountId ? `普通邮箱 ${target.mailboxAddress || accountId}${serverFolderId ? ` · ${target.serverFolderName || serverFolderId.slice(0, 8)}` : ""}` : "临时邮箱", ids: [] }; grouped.set(id, group); }
    group.ids.push(target.id);
  }
  return [...grouped.entries()].sort(([a], [b]) => a === "temporary" ? -1 : b === "temporary" ? 1 : a.localeCompare(b)).map(([id, group]) => ({
    id, name: group.name, accountId: group.accountId, ...(group.serverFolderId ? { serverFolderId: group.serverFolderId } : {}), key: key(), state: "ready", error: "",
    body: Object.freeze({ ...patch, messageIds: Object.freeze([...group.ids].sort()),
      ...(patch.addLabelIds ? { addLabelIds: Object.freeze([...patch.addLabelIds]) } : {}),
      ...(patch.removeLabelIds ? { removeLabelIds: Object.freeze([...patch.removeLabelIds]) } : {}) }),
  }));
}
export const groupWritePath = (group: OrganizationGroup) => group.accountId ? `${normalInboxPath(group.accountId, group.serverFolderId)}/messages/organize` : "/messages/organize";
export const groupReceiptPath = (group: OrganizationGroup) => group.accountId
  ? `${normalInboxPath(group.accountId, group.serverFolderId)}/organization-operations/${group.key}` : `/organization/${group.key}`;

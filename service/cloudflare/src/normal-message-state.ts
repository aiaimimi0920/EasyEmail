export interface NormalPlatformColumns { is_read?: number; starred?: number; archived?: number; trashed_at?: number | null }
export const normalStateJoin = "LEFT JOIN normal_message_state ns ON ns.message_id=m.id";
export const normalStateColumns = "COALESCE(ns.is_read,0) AS is_read,COALESCE(ns.starred,0) AS starred,COALESCE(ns.archived,0) AS archived,ns.trashed_at";
export const normalPlatformState = (row: NormalPlatformColumns) => ({
  isRead: row.is_read === 1, starred: row.starred === 1, archived: row.archived === 1, trashedAt: row.trashed_at ?? null,
});
export function normalFolderCondition(folder: string, alias = "ns") {
  return `${alias}.trashed_at IS ${folder === "trash" ? "NOT " : ""}NULL` +
    (["inbox", "archive"].includes(folder) ? ` AND COALESCE(${alias}.archived,0)=${folder === "archive" ? 1 : 0}` : "");
}

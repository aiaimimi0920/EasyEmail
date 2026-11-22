// Re-evaluate ancestry inside the actual write statement: two concurrent moves cannot create a cycle.
export function folderParentFence(userId: string, id: string, parentId: string | null) {
  if (parentId === null) return { sql: "1", bindings: [] as string[] };
  return { sql: `EXISTS (SELECT 1 FROM folders WHERE user_id=? AND id=? AND deleted_at IS NULL)
    AND NOT EXISTS (WITH RECURSIVE ancestors(id,parent_id) AS (
      SELECT id,parent_id FROM folders WHERE user_id=? AND id=? AND deleted_at IS NULL
      UNION SELECT f.id,f.parent_id FROM folders f JOIN ancestors a ON f.id=a.parent_id WHERE f.user_id=? AND f.deleted_at IS NULL)
      SELECT 1 FROM ancestors WHERE id=?)`, bindings: [userId, parentId, userId, parentId, userId, id] };
}

import { api, type Page } from "./api";
import type { Label } from "./labels-api";

export interface Folder extends Label { parentId: string | null }
export const loadFolders = () => api<Page<Folder>>("/folders?limit=100");

export function folderOptions(folders: Folder[], excludeId?: string) {
  const children = new Map<string | null, Folder[]>(), visited = new Set<string>();
  for (const folder of folders) children.set(folder.parentId, [...(children.get(folder.parentId) ?? []), folder]);
  const result: { folder: Folder; path: string }[] = [];
  function visit(parent: string | null, names: string[], blocked: boolean) {
    for (const folder of (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
      if (visited.has(folder.id)) continue;
      visited.add(folder.id);
      const hidden = blocked || folder.id === excludeId, path = [...names, folder.name];
      if (!hidden) result.push({ folder, path: path.join(" / ") });
      visit(folder.id, path, hidden);
    }
  }
  visit(null, [], false);
  return result;
}

import type { MailTaxonomyItemDto, MailTaxonomyKind } from "../api/mailTaxonomyClient.ts";

export type MailTaxonomyFolderTreeItem = {
  item: MailTaxonomyItemDto;
  depth: number;
};

const FOLDER_COLORS = ["#d9ff38", "#06b6d4", "#22c55e", "#f59e0b", "#f43f5e"];
const LABEL_COLORS = ["#06b6d4", "#22c55e", "#d9ff38", "#f59e0b", "#f43f5e"];

function normalizeTaxonomyName(value: string): string {
  return value.trim().toLowerCase();
}

export function mailTaxonomyDefaultColor(kind: MailTaxonomyKind, index: number): string {
  const colors = kind === "folder" ? FOLDER_COLORS : LABEL_COLORS;
  const normalizedIndex = ((index % colors.length) + colors.length) % colors.length;
  return colors[normalizedIndex];
}

export function mailTaxonomyItemMatchesName(
  item: MailTaxonomyItemDto,
  name: string,
): boolean {
  return normalizeTaxonomyName(item.name) === normalizeTaxonomyName(name);
}

export function buildMailTaxonomyFolderTree(
  items: MailTaxonomyItemDto[],
): MailTaxonomyFolderTreeItem[] {
  const knownIds = new Set(items.map((item) => item.id));
  const childrenByParent = new Map<string | null, MailTaxonomyItemDto[]>();

  items.forEach((item) => {
    const parentId =
      item.parent_id && item.parent_id !== item.id && knownIds.has(item.parent_id)
        ? item.parent_id
        : null;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(item);
    childrenByParent.set(parentId, siblings);
  });

  const ordered: MailTaxonomyFolderTreeItem[] = [];
  const visited = new Set<string>();
  const appendItems = (parentId: string | null, depth: number) => {
    const children = childrenByParent.get(parentId) ?? [];
    children.forEach((item) => {
      if (visited.has(item.id)) {
        return;
      }
      visited.add(item.id);
      ordered.push({ item, depth });
      appendItems(item.id, depth + 1);
    });
  };

  appendItems(null, 0);
  items.forEach((item) => {
    if (!visited.has(item.id)) {
      ordered.push({ item, depth: 0 });
    }
  });

  return ordered;
}

export function isMailTaxonomyFolderDescendant(
  items: MailTaxonomyItemDto[],
  candidateId: string,
  ancestorId: string,
): boolean {
  const byId = new Map(items.map((item) => [item.id, item]));
  let current = byId.get(candidateId)?.parent_id ?? null;
  const seen = new Set<string>();
  while (current) {
    if (current === ancestorId) {
      return true;
    }
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);
    current = byId.get(current)?.parent_id ?? null;
  }
  return false;
}

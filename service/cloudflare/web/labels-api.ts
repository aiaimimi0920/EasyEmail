import { api, type Page } from "./api";

export interface Label { id: string; name: string; color: string; revision: number }
export const LABEL_COLORS = { blue: "蓝色", green: "绿色", orange: "橙色", purple: "紫色", gray: "灰色" };
export const loadLabels = () => api<Page<Label>>("/labels?limit=100");
export interface OrganizationPatch {
  isRead?: boolean; starred?: boolean; archived?: boolean; trashed?: boolean; addLabelIds?: string[]; removeLabelIds?: string[];
  folderId?: string | null;
}
export interface OrganizationResult { operation: { id: string; key: string; messageCount: number; completedAt: number }; replayed: boolean }
export interface TaxonomyController {
  locked: boolean; revision: number; submit: (messageIds: string[], patch: OrganizationPatch) => Promise<void>;
}

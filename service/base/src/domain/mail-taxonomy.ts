export type MailTaxonomyKind = "folder" | "label";

export interface MailTaxonomyItem {
  id: string;
  kind: MailTaxonomyKind;
  name: string;
  parentId?: string;
  color: string;
  sortOrder: number;
  system: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MailTaxonomyCapabilities {
  messageReferencePropagation: boolean;
}

export interface MailTaxonomyListQuery {
  kind: MailTaxonomyKind;
  limit?: number;
  cursor?: string;
}

export interface MailTaxonomyListResult {
  items: MailTaxonomyItem[];
  nextCursor?: string;
  capabilities: MailTaxonomyCapabilities;
}

export interface MailTaxonomyUpsertRequest {
  name: string;
  parentId?: string | null;
  color?: string;
}

export interface MailTaxonomyUpdateRequest {
  expectedVersion: number;
  name: string;
  parentId?: string | null;
  color?: string;
}

export interface MailTaxonomyDeleteRequest {
  expectedVersion: number;
}

export interface MailTaxonomyListPosition {
  sortOrder: number;
  nameKey: string;
  id: string;
}

export interface MailTaxonomyRepositoryListQuery {
  kind: MailTaxonomyKind;
  limit: number;
  after?: MailTaxonomyListPosition;
}

export interface MailTaxonomyRepositoryListResult {
  items: MailTaxonomyItem[];
  hasMore: boolean;
}

export interface MailTaxonomyUpsertInput {
  id: string;
  kind: MailTaxonomyKind;
  name: string;
  normalizedName: string;
  parentId?: string;
  color: string;
  now: string;
}

export interface MailTaxonomyUpdateInput {
  id: string;
  expectedVersion: number;
  name: string;
  normalizedName: string;
  parentId?: string;
  color: string;
  now: string;
}

export interface MailTaxonomyRepository {
  listMailTaxonomyItems(
    query: MailTaxonomyRepositoryListQuery,
  ): Promise<MailTaxonomyRepositoryListResult>;
  getMailTaxonomyItem(id: string): Promise<MailTaxonomyItem | undefined>;
  upsertMailTaxonomyItem(input: MailTaxonomyUpsertInput): Promise<MailTaxonomyItem>;
  updateMailTaxonomyItem(input: MailTaxonomyUpdateInput): Promise<MailTaxonomyItem | undefined>;
  deleteMailTaxonomyItem(id: string, expectedVersion: number): Promise<boolean>;
}

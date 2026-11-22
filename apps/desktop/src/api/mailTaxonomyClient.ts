import type {
  EasyEmailMailTaxonomyDeleteResponse,
  EasyEmailMailTaxonomyItem,
  EasyEmailMailTaxonomyKind,
  EasyEmailMailTaxonomyListQuery,
  EasyEmailMailTaxonomyListResponse,
  EasyEmailMailTaxonomyMutationResponse,
  EasyEmailMailTaxonomyUpdateRequest,
  EasyEmailMailTaxonomyUpsertRequest,
} from "./easyEmailHttpClient.ts";

export type MailTaxonomyKind = EasyEmailMailTaxonomyKind;

export type MailTaxonomyItemDto = {
  id: string;
  kind: MailTaxonomyKind;
  name: string;
  parent_id: string | null;
  color: string;
  sort_order: number;
  system: boolean;
};

export type MailTaxonomyDeleteDto = {
  id: string;
  changed: boolean;
};

export type MailTaxonomyListRequest = {
  kind: MailTaxonomyKind;
};

export type MailTaxonomyUpsertRequest = {
  kind: MailTaxonomyKind;
  name: string;
  parent_id: string | null;
  color: string;
};

export type MailTaxonomyUpdateRequest = {
  id: string;
  name: string;
  parent_id: string | null;
  color: string;
};

export type MailTaxonomyDeleteRequest = {
  id: string;
};

export interface MailTaxonomyHttpTransport {
  listMailTaxonomy(
    query: EasyEmailMailTaxonomyListQuery,
  ): Promise<EasyEmailMailTaxonomyListResponse>;
  getMailTaxonomy(itemId: string): Promise<EasyEmailMailTaxonomyMutationResponse>;
  upsertMailTaxonomy(
    kind: EasyEmailMailTaxonomyKind,
    key: string,
    request: EasyEmailMailTaxonomyUpsertRequest,
  ): Promise<EasyEmailMailTaxonomyMutationResponse>;
  updateMailTaxonomy(
    itemId: string,
    request: EasyEmailMailTaxonomyUpdateRequest,
  ): Promise<EasyEmailMailTaxonomyMutationResponse>;
  deleteMailTaxonomy(
    itemId: string,
    expectedVersion: number,
  ): Promise<EasyEmailMailTaxonomyDeleteResponse>;
}

export function toMailTaxonomySlugKey(name: string): string {
  const collapsed = name.trim().replace(/\s+/gu, " ");
  const slug = collapsed
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return slug || "item";
}

function toMailTaxonomyItemDto(item: EasyEmailMailTaxonomyItem): MailTaxonomyItemDto {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    parent_id: item.parentId ?? null,
    color: item.color,
    sort_order: item.sortOrder,
    system: item.system,
  };
}

export function createMailTaxonomyClient(transport: MailTaxonomyHttpTransport) {
  return {
    async listMailTaxonomyItems(
      request: MailTaxonomyListRequest,
    ): Promise<MailTaxonomyItemDto[]> {
      const items: MailTaxonomyItemDto[] = [];
      let cursor: string | undefined;
      do {
        const page = await transport.listMailTaxonomy({
          kind: request.kind,
          limit: 100,
          cursor,
        });
        items.push(...page.items.map(toMailTaxonomyItemDto));
        cursor = page.nextCursor;
      } while (cursor);
      return items;
    },
    async upsertMailTaxonomyItem(
      request: MailTaxonomyUpsertRequest,
    ): Promise<MailTaxonomyItemDto> {
      const key = toMailTaxonomySlugKey(request.name);
      const response = await transport.upsertMailTaxonomy(request.kind, key, {
        name: request.name,
        ...(request.kind === "folder" ? { parentId: request.parent_id } : {}),
        color: request.color,
      });
      return toMailTaxonomyItemDto(response.item);
    },
    async updateMailTaxonomyItem(
      request: MailTaxonomyUpdateRequest,
    ): Promise<MailTaxonomyItemDto> {
      const current = await transport.getMailTaxonomy(request.id);
      const response = await transport.updateMailTaxonomy(request.id, {
        expectedVersion: current.item.version,
        name: request.name,
        ...(current.item.kind === "folder" ? { parentId: request.parent_id } : {}),
        color: request.color,
      });
      return toMailTaxonomyItemDto(response.item);
    },
    async deleteMailTaxonomyItem(
      request: MailTaxonomyDeleteRequest,
    ): Promise<MailTaxonomyDeleteDto> {
      const current = await transport.getMailTaxonomy(request.id);
      const response = await transport.deleteMailTaxonomy(
        request.id,
        current.item.version,
      );
      return {
        id: response.deleted.id,
        changed: response.deleted.changed,
      };
    },
  };
}

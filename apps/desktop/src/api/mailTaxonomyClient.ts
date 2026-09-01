import type { InvokeCommand } from "./invokeCommand";

export type MailTaxonomyKind = "folder" | "label";

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

export function createMailTaxonomyClient(invokeCommand: InvokeCommand) {
  return {
    listMailTaxonomyItems(
      request: MailTaxonomyListRequest,
    ): Promise<MailTaxonomyItemDto[]> {
      return invokeCommand<MailTaxonomyItemDto[]>("mail_taxonomy_list", {
        request,
      });
    },
    upsertMailTaxonomyItem(
      request: MailTaxonomyUpsertRequest,
    ): Promise<MailTaxonomyItemDto> {
      return invokeCommand<MailTaxonomyItemDto>("mail_taxonomy_upsert", {
        request,
      });
    },
    updateMailTaxonomyItem(
      request: MailTaxonomyUpdateRequest,
    ): Promise<MailTaxonomyItemDto> {
      return invokeCommand<MailTaxonomyItemDto>("mail_taxonomy_update", {
        request,
      });
    },
    deleteMailTaxonomyItem(
      request: MailTaxonomyDeleteRequest,
    ): Promise<MailTaxonomyDeleteDto> {
      return invokeCommand<MailTaxonomyDeleteDto>("mail_taxonomy_delete", {
        request,
      });
    },
  };
}

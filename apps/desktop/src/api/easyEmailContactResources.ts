import type {
  EasyEmailCatalogResponse,
  EasyEmailContact,
  EasyEmailContactCreateRequest,
  EasyEmailContactDeleteResponse,
  EasyEmailContactListQuery,
  EasyEmailContactResponse,
  EasyEmailContactsResponse,
  EasyEmailContactUpdateRequest,
} from "./easyEmailCoreTypes.ts";
import type { EasyEmailRequestTransport } from "./easyEmailHttpTransport.ts";
import { EASY_EMAIL_CORE_ROUTES } from "./easyEmailRoutes.ts";

export function createEasyEmailContactResources(request: EasyEmailRequestTransport) {
  return {
    getCatalog<TCatalog = unknown>(): Promise<EasyEmailCatalogResponse<TCatalog>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.catalog });
    },
    listContacts<TContact = EasyEmailContact>(
      query: EasyEmailContactListQuery = {},
    ): Promise<EasyEmailContactsResponse<TContact>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.contacts, query });
    },
    createContact<TContact = EasyEmailContact>(
      contactRequest: EasyEmailContactCreateRequest,
    ): Promise<EasyEmailContactResponse<TContact>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.contacts,
        body: contactRequest,
      });
    },
    getContact<TContact = EasyEmailContact>(
      contactId: string,
    ): Promise<EasyEmailContactResponse<TContact>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.contact(contactId) });
    },
    updateContact<TContact = EasyEmailContact>(
      contactId: string,
      contactRequest: EasyEmailContactUpdateRequest,
    ): Promise<EasyEmailContactResponse<TContact>> {
      return request({
        method: "PATCH",
        path: EASY_EMAIL_CORE_ROUTES.contact(contactId),
        body: contactRequest,
      });
    },
    deleteContact(
      contactId: string,
      expectedVersion: number,
    ): Promise<EasyEmailContactDeleteResponse> {
      return request({
        method: "DELETE",
        path: EASY_EMAIL_CORE_ROUTES.contact(contactId),
        query: { expectedVersion },
      });
    },
  };
}

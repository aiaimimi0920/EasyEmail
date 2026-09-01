import type {
  EasyEmailContact,
  EasyEmailContactCreateRequest,
  EasyEmailContactListQuery,
  EasyEmailContactResponse,
  EasyEmailContactsResponse,
} from "./easyEmailHttpClient.ts";

export type ContactDto = {
  id: string;
  display_name: string;
  email_address: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type ContactCreateRequest = {
  display_name: string;
  email_address: string;
  note: string | null;
};

export interface ContactHttpTransport {
  listContacts(query?: EasyEmailContactListQuery): Promise<EasyEmailContactsResponse>;
  createContact(request: EasyEmailContactCreateRequest): Promise<EasyEmailContactResponse>;
}

function toContactDto(contact: EasyEmailContact): ContactDto {
  return {
    id: contact.id,
    display_name: contact.displayName,
    email_address: contact.emailAddress,
    note: contact.note ?? null,
    created_at: contact.createdAt,
    updated_at: contact.updatedAt,
  };
}

export function createContactClient(transport: ContactHttpTransport) {
  return {
    async listContacts(): Promise<ContactDto[]> {
      const contacts: ContactDto[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const response = await transport.listContacts({ limit: 100, cursor });
        contacts.push(...response.contacts.map(toContactDto));
        if (response.nextCursor && seenCursors.has(response.nextCursor)) {
          throw new Error("Contact pagination returned a repeated cursor.");
        }
        if (response.nextCursor) seenCursors.add(response.nextCursor);
        cursor = response.nextCursor;
      } while (cursor);
      return contacts;
    },
    async createContact(request: ContactCreateRequest): Promise<ContactDto> {
      const response = await transport.createContact({
        displayName: request.display_name,
        emailAddress: request.email_address,
        note: request.note,
      });
      return toContactDto(response.contact);
    },
  };
}

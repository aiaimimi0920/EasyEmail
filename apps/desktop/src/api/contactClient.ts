import type { InvokeCommand } from "./invokeCommand";

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

export function createContactClient(invokeCommand: InvokeCommand) {
  return {
    listContacts(): Promise<ContactDto[]> {
      return invokeCommand<ContactDto[]>("contact_list");
    },
    createContact(request: ContactCreateRequest): Promise<ContactDto> {
      return invokeCommand<ContactDto>("contact_create", { request });
    },
  };
}

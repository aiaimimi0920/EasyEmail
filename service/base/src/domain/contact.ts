export interface Contact {
  id: string;
  displayName: string;
  emailAddress: string;
  note?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContactListQuery {
  limit?: number;
  cursor?: string;
}

export interface ContactListResult {
  contacts: Contact[];
  nextCursor?: string;
}

export interface ContactCreateInput {
  displayName?: string;
  emailAddress: string;
  note?: string | null;
}

export interface ContactUpdateInput {
  expectedVersion: number;
  displayName?: string;
  emailAddress?: string;
  note?: string | null;
}

export interface ContactDeleteInput {
  expectedVersion: number;
}

export interface ContactListPosition {
  displayNameKey: string;
  emailAddressKey: string;
  id: string;
}

export interface ContactRepositoryListQuery {
  limit: number;
  after?: ContactListPosition;
}

export interface ContactRepositoryListResult {
  contacts: Contact[];
  hasMore: boolean;
}

export interface ContactRepositoryCreateInput extends ContactCreateInput {
  id: string;
  displayName: string;
  note?: string;
  now: string;
}

export interface ContactRepositoryUpdateInput {
  id: string;
  expectedVersion: number;
  displayName: string;
  emailAddress: string;
  note?: string;
  now: string;
}

export interface ContactRepository {
  listContacts(query: ContactRepositoryListQuery): Promise<ContactRepositoryListResult>;
  getContact(id: string): Promise<Contact | undefined>;
  createContact(input: ContactRepositoryCreateInput): Promise<Contact>;
  updateContact(input: ContactRepositoryUpdateInput): Promise<Contact | undefined>;
  deleteContact(id: string, expectedVersion: number): Promise<boolean>;
}

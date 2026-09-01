import { randomUUID } from "node:crypto";
import { EasyEmailError } from "../domain/errors.js";
import type {
  Contact,
  ContactCreateInput,
  ContactDeleteInput,
  ContactListPosition,
  ContactListQuery,
  ContactListResult,
  ContactRepository,
  ContactUpdateInput,
} from "../domain/contact.js";

const DEFAULT_CONTACT_PAGE_SIZE = 50;
const MAX_CONTACT_PAGE_SIZE = 100;

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function normalizeEmailAddress(value: unknown): string {
  if (typeof value !== "string") {
    throw new EasyEmailError("INVALID_CONTACT", "emailAddress must be a string.");
  }
  const trimmed = value.trim();
  const start = trimmed.indexOf("<");
  const end = trimmed.lastIndexOf(">");
  const candidate = start >= 0 && end > start
    ? trimmed.slice(start + 1, end).trim()
    : trimmed;
  const normalized = asciiLower(candidate);
  if (!normalized.includes("@") || normalized.startsWith("@") || normalized.endsWith("@")) {
    throw new EasyEmailError("INVALID_CONTACT", "emailAddress must be a valid mailbox address.");
  }
  return normalized;
}

function normalizeDisplayName(displayName: unknown, emailAddress: string): string {
  if (displayName !== undefined && typeof displayName !== "string") {
    throw new EasyEmailError("INVALID_CONTACT", "displayName must be a string.");
  }
  const trimmed = typeof displayName === "string" ? displayName.trim() : "";
  if (trimmed) return trimmed;

  const localPart = emailAddress.split("@")[0]?.trim() || "Contact";
  return `${localPart.slice(0, 1).toUpperCase()}${localPart.slice(1)}`;
}

function normalizeNote(note: unknown): string | undefined {
  if (note !== null && note !== undefined && typeof note !== "string") {
    throw new EasyEmailError("INVALID_CONTACT", "note must be a string or null.");
  }
  const normalized = typeof note === "string" ? note.trim() : undefined;
  return normalized || undefined;
}

function normalizeExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new EasyEmailError("INVALID_CONTACT", "expectedVersion must be a positive integer.");
  }
  return value;
}

function encodeCursor(contact: Contact): string {
  const position: ContactListPosition = {
    displayNameKey: asciiLower(contact.displayName),
    emailAddressKey: asciiLower(contact.emailAddress),
    id: contact.id,
  };
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): ContactListPosition {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.displayNameKey !== "string"
      || typeof record.emailAddressKey !== "string"
      || typeof record.id !== "string"
      || !record.id
    ) {
      throw new Error("missing cursor fields");
    }
    return {
      displayNameKey: record.displayNameKey,
      emailAddressKey: record.emailAddressKey,
      id: record.id,
    };
  } catch {
    throw new EasyEmailError("INVALID_CONTACT_CURSOR", "Contact cursor is invalid.");
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return record.code === "ERR_SQLITE_ERROR"
    && typeof record.message === "string"
    && record.message.includes("UNIQUE constraint failed: contacts.email_address");
}

export class ContactService {
  public constructor(
    private readonly repository: ContactRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async listContacts(query: ContactListQuery = {}): Promise<ContactListResult> {
    const limit = query.limit ?? DEFAULT_CONTACT_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONTACT_PAGE_SIZE) {
      throw new EasyEmailError(
        "INVALID_QUERY",
        `Contact limit must be an integer from 1 to ${MAX_CONTACT_PAGE_SIZE}.`,
      );
    }

    const result = await this.repository.listContacts({
      limit,
      after: query.cursor ? decodeCursor(query.cursor) : undefined,
    });
    const lastContact = result.contacts.at(-1);
    return {
      contacts: result.contacts,
      nextCursor: result.hasMore && lastContact ? encodeCursor(lastContact) : undefined,
    };
  }

  public async getContact(id: string): Promise<Contact> {
    const contact = await this.repository.getContact(id.trim());
    if (!contact) {
      throw new EasyEmailError("CONTACT_NOT_FOUND", `Contact ${id} was not found.`);
    }
    return contact;
  }

  public async createContact(input: ContactCreateInput): Promise<Contact> {
    const emailAddress = normalizeEmailAddress(input.emailAddress);
    return this.repository.createContact({
      id: `contact_${randomUUID()}`,
      displayName: normalizeDisplayName(input.displayName, emailAddress),
      emailAddress,
      note: normalizeNote(input.note),
      now: this.now().toISOString(),
    });
  }

  public async updateContact(id: string, input: ContactUpdateInput): Promise<Contact> {
    const existing = await this.getContact(id);
    const expectedVersion = normalizeExpectedVersion(input.expectedVersion);
    if (existing.version !== expectedVersion) {
      throw new EasyEmailError("CONTACT_VERSION_CONFLICT", "Contact was changed by another request.");
    }
    if (input.displayName === undefined && input.emailAddress === undefined && input.note === undefined) {
      throw new EasyEmailError("INVALID_CONTACT", "At least one contact field must be updated.");
    }

    const emailAddress = input.emailAddress === undefined
      ? existing.emailAddress
      : normalizeEmailAddress(input.emailAddress);
    const displayName = input.displayName === undefined
      ? existing.displayName
      : normalizeDisplayName(input.displayName, emailAddress);

    try {
      const updated = await this.repository.updateContact({
        id: existing.id,
        expectedVersion,
        displayName,
        emailAddress,
        note: input.note === undefined ? existing.note : normalizeNote(input.note),
        now: this.now().toISOString(),
      });
      if (!updated) {
        throw new EasyEmailError("CONTACT_VERSION_CONFLICT", "Contact was changed by another request.");
      }
      return updated;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new EasyEmailError("CONTACT_EMAIL_CONFLICT", "Another contact already uses that email address.");
      }
      throw error;
    }
  }

  public async deleteContact(id: string, input: ContactDeleteInput): Promise<{ id: string }> {
    const expectedVersion = normalizeExpectedVersion(input.expectedVersion);
    const existing = await this.getContact(id);
    if (existing.version !== expectedVersion) {
      throw new EasyEmailError("CONTACT_VERSION_CONFLICT", "Contact was changed by another request.");
    }
    if (!await this.repository.deleteContact(existing.id, expectedVersion)) {
      throw new EasyEmailError("CONTACT_VERSION_CONFLICT", "Contact was changed by another request.");
    }
    return { id: existing.id };
  }
}

export function createContactService(
  repository: ContactRepository,
  now?: () => Date,
): ContactService {
  return new ContactService(repository, now);
}

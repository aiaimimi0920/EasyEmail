import { DatabaseSync } from "node:sqlite";

import type {
  Contact,
  ContactRepository,
  ContactRepositoryCreateInput,
  ContactRepositoryListQuery,
  ContactRepositoryListResult,
  ContactRepositoryUpdateInput,
} from "../../domain/contact.js";

interface ContactSqlRow {
  id: string;
  display_name: string;
  email_address: string;
  note: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

function mapContact(row: ContactSqlRow): Contact {
  return {
    id: row.id,
    displayName: row.display_name,
    emailAddress: row.email_address,
    note: row.note ?? undefined,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readContactRow(value: unknown): ContactSqlRow | undefined {
  return value as ContactSqlRow | undefined;
}

function selectContactById(database: DatabaseSync, id: string): Contact | undefined {
  const row = readContactRow(database.prepare(`
    SELECT id, display_name, email_address, note, version, created_at, updated_at
    FROM contacts
    WHERE id = ?
  `).get(id));
  return row ? mapContact(row) : undefined;
}

export class SqliteContactRepository implements ContactRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public async listContacts(query: ContactRepositoryListQuery): Promise<ContactRepositoryListResult> {
    const params: Array<string | number> = [];
    let where = "";
    if (query.after) {
      where = `WHERE (
        lower(display_name) > ?
        OR (lower(display_name) = ? AND lower(email_address) > ?)
        OR (lower(display_name) = ? AND lower(email_address) = ? AND id > ?)
      )`;
      params.push(
        query.after.displayNameKey,
        query.after.displayNameKey,
        query.after.emailAddressKey,
        query.after.displayNameKey,
        query.after.emailAddressKey,
        query.after.id,
      );
    }
    params.push(query.limit + 1);
    const rows = this.database.prepare(`
      SELECT id, display_name, email_address, note, version, created_at, updated_at
      FROM contacts
      ${where}
      ORDER BY display_name COLLATE NOCASE ASC, email_address COLLATE NOCASE ASC, id ASC
      LIMIT ?
    `).all(...params) as unknown as ContactSqlRow[];
    return {
      contacts: rows.slice(0, query.limit).map(mapContact),
      hasMore: rows.length > query.limit,
    };
  }

  public async getContact(id: string): Promise<Contact | undefined> {
    return selectContactById(this.database, id);
  }

  public async createContact(input: ContactRepositoryCreateInput): Promise<Contact> {
    this.database.prepare(`
      INSERT INTO contacts (
        id, display_name, email_address, note, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(email_address) DO UPDATE SET
        display_name = excluded.display_name,
        note = excluded.note,
        version = contacts.version + 1,
        updated_at = excluded.updated_at
    `).run(
      input.id,
      input.displayName,
      input.emailAddress,
      input.note ?? null,
      input.now,
      input.now,
    );
    const row = readContactRow(this.database.prepare(`
      SELECT id, display_name, email_address, note, version, created_at, updated_at
      FROM contacts
      WHERE email_address = ?
    `).get(input.emailAddress));
    if (!row) throw new Error("Contact upsert did not return a row.");
    return mapContact(row);
  }

  public async updateContact(input: ContactRepositoryUpdateInput): Promise<Contact | undefined> {
    const row = readContactRow(this.database.prepare(`
      UPDATE contacts
      SET display_name = ?, email_address = ?, note = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
      RETURNING id, display_name, email_address, note, version, created_at, updated_at
    `).get(
      input.displayName,
      input.emailAddress,
      input.note ?? null,
      input.now,
      input.id,
      input.expectedVersion,
    ));
    return row ? mapContact(row) : undefined;
  }

  public async deleteContact(id: string, expectedVersion: number): Promise<boolean> {
    const result = this.database.prepare(
      "DELETE FROM contacts WHERE id = ? AND version = ?",
    ).run(id, expectedVersion);
    return result.changes === 1;
  }
}

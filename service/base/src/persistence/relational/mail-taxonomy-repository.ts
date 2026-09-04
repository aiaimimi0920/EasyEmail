import { DatabaseSync } from "node:sqlite";

import type {
  MailTaxonomyItem,
  MailTaxonomyRepository,
  MailTaxonomyRepositoryListQuery,
  MailTaxonomyRepositoryListResult,
  MailTaxonomyUpdateInput,
  MailTaxonomyUpsertInput,
} from "../../domain/mail-taxonomy.js";

interface MailTaxonomySqlRow {
  id: string;
  kind: "folder" | "label";
  name: string;
  normalized_name: string;
  parent_id: string | null;
  color: string;
  sort_order: number;
  system: number;
  version: number;
  created_at: string;
  updated_at: string;
}

function mapMailTaxonomyItem(row: MailTaxonomySqlRow): MailTaxonomyItem {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    parentId: row.parent_id ?? undefined,
    color: row.color,
    sortOrder: row.sort_order,
    system: row.system === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteMailTaxonomyRepository implements MailTaxonomyRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public async listMailTaxonomyItems(
    query: MailTaxonomyRepositoryListQuery,
  ): Promise<MailTaxonomyRepositoryListResult> {
    const params: Array<string | number> = [query.kind];
    let where = "WHERE kind = ?";
    if (query.after) {
      where += ` AND (
        sort_order > ?
        OR (sort_order = ? AND lower(name) > ?)
        OR (sort_order = ? AND lower(name) = ? AND id > ?)
      )`;
      params.push(
        query.after.sortOrder,
        query.after.sortOrder,
        query.after.nameKey,
        query.after.sortOrder,
        query.after.nameKey,
        query.after.id,
      );
    }
    params.push(query.limit + 1);
    const rows = this.database.prepare(`
      SELECT id, kind, name, normalized_name, parent_id, color, sort_order,
             system, version, created_at, updated_at
      FROM mail_taxonomy_items
      ${where}
      ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC
      LIMIT ?
    `).all(...params) as unknown as MailTaxonomySqlRow[];
    return {
      items: rows.slice(0, query.limit).map(mapMailTaxonomyItem),
      hasMore: rows.length > query.limit,
    };
  }

  public async getMailTaxonomyItem(id: string): Promise<MailTaxonomyItem | undefined> {
    const row = this.database.prepare(`
      SELECT id, kind, name, normalized_name, parent_id, color, sort_order,
             system, version, created_at, updated_at
      FROM mail_taxonomy_items
      WHERE id = ?
    `).get(id) as unknown as MailTaxonomySqlRow | undefined;
    return row ? mapMailTaxonomyItem(row) : undefined;
  }

  public async upsertMailTaxonomyItem(input: MailTaxonomyUpsertInput): Promise<MailTaxonomyItem> {
    const existing = this.database.prepare(
      "SELECT id FROM mail_taxonomy_items WHERE kind = ? AND normalized_name = ?",
    ).get(input.kind, input.normalizedName) as { id: string } | undefined;
    const id = existing?.id ?? input.id;
    const sortOrder = existing
      ? undefined
      : (this.database.prepare(
        "SELECT COALESCE(MAX(sort_order), 0) + 10 AS value FROM mail_taxonomy_items WHERE kind = ?",
      ).get(input.kind) as { value: number }).value;
    this.database.prepare(`
      INSERT INTO mail_taxonomy_items (
        id, kind, name, normalized_name, parent_id, color, sort_order, system,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
      ON CONFLICT(kind, normalized_name) DO UPDATE SET
        name = excluded.name,
        parent_id = excluded.parent_id,
        color = excluded.color,
        version = mail_taxonomy_items.version + 1,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.kind,
      input.name,
      input.normalizedName,
      input.parentId ?? null,
      input.color,
      sortOrder ?? 0,
      input.now,
      input.now,
    );
    const result = await this.getMailTaxonomyItem(id);
    if (!result) throw new Error("Mail taxonomy upsert did not return a row.");
    return result;
  }

  public async updateMailTaxonomyItem(
    input: MailTaxonomyUpdateInput,
  ): Promise<MailTaxonomyItem | undefined> {
    const row = this.database.prepare(`
      UPDATE mail_taxonomy_items
      SET name = ?, normalized_name = ?, parent_id = ?, color = ?,
          version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
      RETURNING id, kind, name, normalized_name, parent_id, color, sort_order,
                system, version, created_at, updated_at
    `).get(
      input.name,
      input.normalizedName,
      input.parentId ?? null,
      input.color,
      input.now,
      input.id,
      input.expectedVersion,
    ) as unknown as MailTaxonomySqlRow | undefined;
    return row ? mapMailTaxonomyItem(row) : undefined;
  }

  public async deleteMailTaxonomyItem(id: string, expectedVersion: number): Promise<boolean> {
    const result = this.database.prepare(
      "DELETE FROM mail_taxonomy_items WHERE id = ? AND version = ? AND system = 0",
    ).run(id, expectedVersion);
    return result.changes === 1;
  }
}

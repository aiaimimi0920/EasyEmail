import { EasyEmailError } from "../domain/errors.js";
import type {
  MailTaxonomyCapabilities,
  MailTaxonomyDeleteRequest,
  MailTaxonomyItem,
  MailTaxonomyKind,
  MailTaxonomyListPosition,
  MailTaxonomyListQuery,
  MailTaxonomyListResult,
  MailTaxonomyRepository,
  MailTaxonomyUpdateRequest,
  MailTaxonomyUpsertRequest,
} from "../domain/mail-taxonomy.js";

const DEFAULT_TAXONOMY_PAGE_SIZE = 50;
const MAX_TAXONOMY_PAGE_SIZE = 100;
const DEFAULT_TAXONOMY_COLOR = "#8b5cf6";

interface MailTaxonomyCursor extends MailTaxonomyListPosition {
  kind: MailTaxonomyKind;
}

export const MAIL_TAXONOMY_CAPABILITIES: MailTaxonomyCapabilities = {
  messageReferencePropagation: false,
};

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function normalizeKind(value: unknown): MailTaxonomyKind {
  if (value !== "folder" && value !== "label") {
    throw new EasyEmailError(
      "MAIL_TAXONOMY_KIND_UNSUPPORTED",
      "Mail taxonomy kind must be folder or label.",
    );
  }
  return value;
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") {
    throw new EasyEmailError("INVALID_MAIL_TAXONOMY", "Taxonomy name must be a string.");
  }
  const normalized = value.trim().split(/\s+/u).filter(Boolean).join(" ");
  if (!normalized || Array.from(normalized).length > 64) {
    throw new EasyEmailError(
      "INVALID_MAIL_TAXONOMY",
      "Taxonomy name must contain from 1 to 64 characters.",
    );
  }
  return normalized;
}

function normalizeColor(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TAXONOMY_COLOR;
  const normalized = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : DEFAULT_TAXONOMY_COLOR;
}

function normalizeExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new EasyEmailError(
      "INVALID_MAIL_TAXONOMY",
      "expectedVersion must be a positive integer.",
    );
  }
  return value;
}

function normalizeParentId(value: unknown): string | undefined {
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw new EasyEmailError(
      "INVALID_MAIL_TAXONOMY",
      "parentId must be a string or null.",
    );
  }
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

export function mailTaxonomyKey(name: string): string {
  const key = Array.from(asciiLower(name), (character) => (
    /^[a-z0-9]$/.test(character) ? character : "_"
  )).join("").replace(/^_+|_+$/g, "");
  return key || "item";
}

function encodeCursor(item: MailTaxonomyItem): string {
  const position: MailTaxonomyCursor = {
    kind: item.kind,
    sortOrder: item.sortOrder,
    nameKey: asciiLower(item.name),
    id: item.id,
  };
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, expectedKind: MailTaxonomyKind): MailTaxonomyListPosition {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    const record = parsed as Record<string, unknown>;
    if (
      record.kind !== expectedKind
      || typeof record.sortOrder !== "number"
      || !Number.isSafeInteger(record.sortOrder)
      || typeof record.nameKey !== "string"
      || typeof record.id !== "string"
      || !record.id
    ) {
      throw new Error("missing cursor fields");
    }
    return {
      sortOrder: record.sortOrder,
      nameKey: record.nameKey,
      id: record.id,
    };
  } catch {
    throw new EasyEmailError(
      "INVALID_MAIL_TAXONOMY_CURSOR",
      "Mail taxonomy cursor is invalid.",
    );
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return record.code === "ERR_SQLITE_ERROR"
    && typeof record.message === "string"
    && (
      record.message.includes("mail_taxonomy_items.kind, mail_taxonomy_items.normalized_name")
      || record.message.includes("mail_taxonomy_items.id")
    );
}

export class MailTaxonomyService {
  public constructor(
    private readonly repository: MailTaxonomyRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async listItems(query: MailTaxonomyListQuery): Promise<MailTaxonomyListResult> {
    const kind = normalizeKind(query.kind);
    const limit = query.limit ?? DEFAULT_TAXONOMY_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TAXONOMY_PAGE_SIZE) {
      throw new EasyEmailError(
        "INVALID_QUERY",
        `Mail taxonomy limit must be an integer from 1 to ${MAX_TAXONOMY_PAGE_SIZE}.`,
      );
    }
    const result = await this.repository.listMailTaxonomyItems({
      kind,
      limit,
      after: query.cursor ? decodeCursor(query.cursor, kind) : undefined,
    });
    const lastItem = result.items.at(-1);
    return {
      items: result.items,
      nextCursor: result.hasMore && lastItem ? encodeCursor(lastItem) : undefined,
      capabilities: MAIL_TAXONOMY_CAPABILITIES,
    };
  }

  public async getItem(id: string): Promise<MailTaxonomyItem> {
    const normalizedId = id.trim();
    const item = normalizedId
      ? await this.repository.getMailTaxonomyItem(normalizedId)
      : undefined;
    if (!item) {
      throw new EasyEmailError(
        "MAIL_TAXONOMY_NOT_FOUND",
        `Mail taxonomy item ${id} was not found.`,
      );
    }
    return item;
  }

  private async validateParent(
    kind: MailTaxonomyKind,
    parentId: string | undefined,
    updatedItemId?: string,
  ): Promise<void> {
    if (kind === "label") {
      if (parentId) {
        throw new EasyEmailError(
          "MAIL_TAXONOMY_PARENT_UNSUPPORTED",
          "Labels cannot have a parent taxonomy item.",
        );
      }
      return;
    }
    if (!parentId) return;
    if (parentId === updatedItemId) {
      throw new EasyEmailError("MAIL_TAXONOMY_PARENT_CYCLE", "A folder cannot parent itself.");
    }

    const visited = new Set<string>();
    let currentId: string | undefined = parentId;
    while (currentId) {
      if (currentId === updatedItemId || visited.has(currentId)) {
        throw new EasyEmailError(
          "MAIL_TAXONOMY_PARENT_CYCLE",
          "Folder parent relationships cannot contain a cycle.",
        );
      }
      visited.add(currentId);
      const current = await this.repository.getMailTaxonomyItem(currentId);
      if (!current || current.kind !== "folder") {
        throw new EasyEmailError(
          "MAIL_TAXONOMY_PARENT_NOT_FOUND",
          `Parent folder ${currentId} was not found.`,
        );
      }
      currentId = current.parentId;
    }
  }

  public async upsertItem(
    rawKind: unknown,
    key: string,
    request: MailTaxonomyUpsertRequest,
  ): Promise<MailTaxonomyItem> {
    const kind = normalizeKind(rawKind);
    const name = normalizeName(request.name);
    const normalizedName = asciiLower(name);
    const expectedKey = mailTaxonomyKey(normalizedName);
    if (key !== expectedKey) {
      throw new EasyEmailError(
        "INVALID_MAIL_TAXONOMY",
        `Taxonomy key must be ${expectedKey} for the requested name.`,
      );
    }
    const parentId = normalizeParentId(request.parentId);
    await this.validateParent(kind, parentId);
    try {
      return await this.repository.upsertMailTaxonomyItem({
        id: `mailtax_${kind}_${key}`,
        kind,
        name,
        normalizedName,
        parentId,
        color: normalizeColor(request.color),
        now: this.now().toISOString(),
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new EasyEmailError(
          "MAIL_TAXONOMY_NAME_CONFLICT",
          "Another taxonomy item already uses that name or key.",
        );
      }
      throw error;
    }
  }

  public async updateItem(
    id: string,
    request: MailTaxonomyUpdateRequest,
  ): Promise<MailTaxonomyItem> {
    const existing = await this.getItem(id);
    const expectedVersion = normalizeExpectedVersion(request.expectedVersion);
    if (existing.version !== expectedVersion) {
      throw new EasyEmailError(
        "MAIL_TAXONOMY_VERSION_CONFLICT",
        "Mail taxonomy item was changed by another request.",
      );
    }
    const name = normalizeName(request.name);
    const parentId = normalizeParentId(request.parentId);
    await this.validateParent(existing.kind, parentId, existing.id);
    try {
      const updated = await this.repository.updateMailTaxonomyItem({
        id: existing.id,
        expectedVersion,
        name,
        normalizedName: asciiLower(name),
        parentId,
        color: normalizeColor(request.color),
        now: this.now().toISOString(),
      });
      if (!updated) {
        throw new EasyEmailError(
          "MAIL_TAXONOMY_VERSION_CONFLICT",
          "Mail taxonomy item was changed by another request.",
        );
      }
      return updated;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new EasyEmailError(
          "MAIL_TAXONOMY_NAME_CONFLICT",
          "Another taxonomy item already uses that name.",
        );
      }
      throw error;
    }
  }

  public async deleteItem(
    id: string,
    request: MailTaxonomyDeleteRequest,
  ): Promise<{ id: string; changed: boolean }> {
    const existing = await this.getItem(id);
    const expectedVersion = normalizeExpectedVersion(request.expectedVersion);
    if (existing.version !== expectedVersion) {
      throw new EasyEmailError(
        "MAIL_TAXONOMY_VERSION_CONFLICT",
        "Mail taxonomy item was changed by another request.",
      );
    }
    if (existing.system) return { id: existing.id, changed: false };
    if (!await this.repository.deleteMailTaxonomyItem(existing.id, expectedVersion)) {
      throw new EasyEmailError(
        "MAIL_TAXONOMY_VERSION_CONFLICT",
        "Mail taxonomy item was changed by another request.",
      );
    }
    return { id: existing.id, changed: true };
  }
}

export function createMailTaxonomyService(
  repository: MailTaxonomyRepository,
  now?: () => Date,
): MailTaxonomyService {
  return new MailTaxonomyService(repository, now);
}

import { describe, expect, it } from "vitest";

import type {
  MailTaxonomyItem,
  MailTaxonomyRepository,
  MailTaxonomyRepositoryListQuery,
  MailTaxonomyUpdateInput,
  MailTaxonomyUpsertInput,
} from "../../src/domain/mail-taxonomy.js";
import { MailTaxonomyService, mailTaxonomyKey } from "../../src/service/mail-taxonomy.js";

class MemoryTaxonomyRepository implements MailTaxonomyRepository {
  public readonly items = new Map<string, MailTaxonomyItem>();

  public async listMailTaxonomyItems(query: MailTaxonomyRepositoryListQuery) {
    const items = [...this.items.values()]
      .filter((item) => item.kind === query.kind)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
      .slice(0, query.limit + 1);
    return { items: items.slice(0, query.limit), hasMore: items.length > query.limit };
  }

  public async getMailTaxonomyItem(id: string) {
    return this.items.get(id);
  }

  public async upsertMailTaxonomyItem(input: MailTaxonomyUpsertInput) {
    const existing = [...this.items.values()].find(
      (item) => item.kind === input.kind && item.name.toLowerCase() === input.normalizedName,
    );
    const item: MailTaxonomyItem = {
      id: existing?.id ?? input.id,
      kind: input.kind,
      name: input.name,
      parentId: input.parentId,
      color: input.color,
      sortOrder: existing?.sortOrder ?? this.items.size * 10 + 10,
      system: existing?.system ?? false,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    this.items.set(item.id, item);
    return item;
  }

  public async updateMailTaxonomyItem(input: MailTaxonomyUpdateInput) {
    const existing = this.items.get(input.id);
    if (!existing || existing.version !== input.expectedVersion) return undefined;
    const item = {
      ...existing,
      name: input.name,
      parentId: input.parentId,
      color: input.color,
      version: existing.version + 1,
      updatedAt: input.now,
    };
    this.items.set(item.id, item);
    return item;
  }

  public async deleteMailTaxonomyItem(id: string, expectedVersion: number) {
    const existing = this.items.get(id);
    return Boolean(existing && existing.version === expectedVersion && this.items.delete(id));
  }
}

describe("MailTaxonomyService", () => {
  it("normalizes legacy keys and rejects unsupported kinds, parents, and cycles", async () => {
    expect(mailTaxonomyKey(" Team / Alpha ")).toBe("team___alpha");
    expect(mailTaxonomyKey("中文")).toBe("item");

    const repository = new MemoryTaxonomyRepository();
    const service = new MailTaxonomyService(
      repository,
      () => new Date("2026-09-01T10:00:00.000Z"),
    );
    await expect(service.upsertItem("unknown", "item", { name: "Item" }))
      .rejects.toMatchObject({ code: "MAIL_TAXONOMY_KIND_UNSUPPORTED" });
    await expect(service.upsertItem("label", "work", { name: "Work", parentId: "folder" }))
      .rejects.toMatchObject({ code: "MAIL_TAXONOMY_PARENT_UNSUPPORTED" });

    const parent = await service.upsertItem("folder", "parent", {
      name: " Parent ",
      color: "INVALID",
    });
    const child = await service.upsertItem("folder", "child", {
      name: "Child",
      parentId: parent.id,
      color: "#ABCDEF",
    });
    expect(parent).toMatchObject({ name: "Parent", color: "#8b5cf6", version: 1 });
    expect(child).toMatchObject({ parentId: parent.id, color: "#abcdef" });

    await expect(service.updateItem(parent.id, {
      expectedVersion: 1,
      name: "Parent",
      parentId: child.id,
    })).rejects.toMatchObject({ code: "MAIL_TAXONOMY_PARENT_CYCLE" });
  });

  it("exposes the missing message propagation capability and enforces CAS", async () => {
    const repository = new MemoryTaxonomyRepository();
    const service = new MailTaxonomyService(repository);
    const item = await service.upsertItem("label", "security", { name: "Security" });
    const listed = await service.listItems({ kind: "label" });
    expect(listed.capabilities).toEqual({ messageReferencePropagation: false });

    await expect(service.updateItem(item.id, {
      expectedVersion: 2,
      name: "Security alerts",
    })).rejects.toMatchObject({ code: "MAIL_TAXONOMY_VERSION_CONFLICT" });
    await expect(service.deleteItem(item.id, { expectedVersion: 2 }))
      .rejects.toMatchObject({ code: "MAIL_TAXONOMY_VERSION_CONFLICT" });
  });

  it("rejects pagination cursors issued for another taxonomy kind", async () => {
    const repository = new MemoryTaxonomyRepository();
    const service = new MailTaxonomyService(repository);
    await service.upsertItem("folder", "alpha", { name: "Alpha" });
    await service.upsertItem("folder", "beta", { name: "Beta" });

    const firstPage = await service.listItems({ kind: "folder", limit: 1 });
    expect(firstPage.nextCursor).toBeDefined();
    await expect(service.listItems({
      kind: "label",
      cursor: firstPage.nextCursor,
    })).rejects.toMatchObject({ code: "INVALID_MAIL_TAXONOMY_CURSOR" });
  });
});

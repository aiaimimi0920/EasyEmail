import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SqliteRelationalDatabase } from "../../src/persistence/relational/database.js";
import { MailTaxonomyService } from "../../src/service/mail-taxonomy.js";

describe("mail taxonomy relational persistence", () => {
  it("preserves identity, ordering, pagination, parent deletion, CAS, and restart readback", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-taxonomy-"));
    const databasePath = join(root, "easy-email-relational.sqlite3");
    let tick = 0;
    const now = () => new Date(Date.parse("2026-09-01T10:30:00.000Z") + tick++ * 1000);

    try {
      const database = new SqliteRelationalDatabase({ databasePath });
      const taxonomy = new MailTaxonomyService(database, now);
      const parent = await taxonomy.upsertItem("folder", "parent", { name: "Parent" });
      const child = await taxonomy.upsertItem("folder", "child", {
        name: "Child",
        parentId: parent.id,
      });
      const later = await taxonomy.upsertItem("folder", "later", { name: "Later" });
      const firstPage = await taxonomy.listItems({ kind: "folder", limit: 2 });
      expect(firstPage.items.map((item) => item.id)).toEqual([parent.id, child.id]);
      expect(firstPage.nextCursor).toBeTruthy();
      const secondPage = await taxonomy.listItems({
        kind: "folder",
        limit: 2,
        cursor: firstPage.nextCursor,
      });
      expect(secondPage.items.map((item) => item.id)).toEqual([later.id]);

      const upserted = await taxonomy.upsertItem("folder", "parent", {
        name: "PARENT",
        color: "#123456",
      });
      expect(upserted).toMatchObject({ id: parent.id, version: 2, color: "#123456" });
      expect(upserted.createdAt).toBe(parent.createdAt);
      const updated = await taxonomy.updateItem(child.id, {
        expectedVersion: 1,
        name: "Nested",
        parentId: parent.id,
        color: "#abcdef",
      });
      expect(updated).toMatchObject({ id: child.id, version: 2, name: "Nested" });
      const upsertedAfterRename = await taxonomy.upsertItem("folder", "nested", {
        name: "Nested",
        parentId: parent.id,
      });
      expect(upsertedAfterRename).toMatchObject({ id: child.id, version: 3 });
      await expect(taxonomy.updateItem(child.id, {
        expectedVersion: 1,
        name: "Stale",
      })).rejects.toMatchObject({ code: "MAIL_TAXONOMY_VERSION_CONFLICT" });

      await expect(taxonomy.deleteItem(parent.id, { expectedVersion: 2 }))
        .resolves.toEqual({ id: parent.id, changed: true });
      expect(await taxonomy.getItem(child.id)).toMatchObject({ parentId: undefined });
      database.close();

      const restarted = new SqliteRelationalDatabase({ databasePath });
      try {
        const restored = new MailTaxonomyService(restarted, now);
        await expect(restored.getItem(parent.id))
          .rejects.toMatchObject({ code: "MAIL_TAXONOMY_NOT_FOUND" });
        await expect(restored.getItem(child.id)).resolves.toMatchObject({
          id: child.id,
          name: "Nested",
          version: 3,
        });
      } finally {
        restarted.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the same ASCII-only name key for Unicode pagination as SQLite NOCASE", async () => {
    const database = new SqliteRelationalDatabase({ databasePath: ":memory:" });
    const taxonomy = new MailTaxonomyService(database);
    try {
      const created = await Promise.all([
        taxonomy.upsertItem("label", "lg_a", { name: "Älg A" }),
        taxonomy.upsertItem("label", "lg_b", { name: "älg B" }),
        taxonomy.upsertItem("label", "c", { name: "中 C" }),
      ]);
      const first = await taxonomy.listItems({ kind: "label", limit: 1 });
      const second = await taxonomy.listItems({
        kind: "label",
        limit: 1,
        cursor: first.nextCursor,
      });
      const third = await taxonomy.listItems({
        kind: "label",
        limit: 1,
        cursor: second.nextCursor,
      });
      expect(new Set([
        first.items[0]?.id,
        second.items[0]?.id,
        third.items[0]?.id,
      ])).toEqual(new Set(created.map((item) => item.id)));
      expect(third.nextCursor).toBeUndefined();
    } finally {
      database.close();
    }
  });
});

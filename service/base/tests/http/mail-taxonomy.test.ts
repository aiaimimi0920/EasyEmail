import { describe, expect, it } from "vitest";

import { EasyEmailHttpHandler } from "../../src/http/handler.js";
import { createEasyEmailHttpServer } from "../../src/http/server.js";
import { SqliteRelationalDatabase } from "../../src/persistence/relational/database.js";
import { createEasyEmailService } from "../../src/service/easy-email-service.js";
import { MailTaxonomyService } from "../../src/service/mail-taxonomy.js";

const AUTHORIZATION = { authorization: "Bearer taxonomy-test-token" };
const JSON_HEADERS = { ...AUTHORIZATION, "content-type": "application/json" };

describe("mail taxonomy HTTP resources", () => {
  it("dispatches authenticated CRUD, hierarchy, capability, and conflict semantics", async () => {
    const database = new SqliteRelationalDatabase({ databasePath: ":memory:" });
    const taxonomy = new MailTaxonomyService(
      database,
      () => new Date("2026-09-01T11:00:00.000Z"),
    );
    const handler = new EasyEmailHttpHandler(
      createEasyEmailService(),
      undefined,
      undefined,
      taxonomy,
    );
    const server = await createEasyEmailHttpServer(handler, { apiKey: "taxonomy-test-token" });

    try {
      const unauthorized = await fetch(`${server.baseUrl}/mail/taxonomy?kind=folder`);
      expect(unauthorized.status).toBe(401);

      const parentResponse = await fetch(`${server.baseUrl}/mail/taxonomy/folder/parent`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: " Parent ", color: "#ABCDEF" }),
      });
      expect(parentResponse.status).toBe(200);
      const parentPayload = await parentResponse.json() as {
        item: { id: string; version: number };
      };
      expect(parentPayload).toMatchObject({
        item: { name: "Parent", color: "#abcdef", version: 1 },
        capabilities: { messageReferencePropagation: false },
      });

      const childResponse = await fetch(`${server.baseUrl}/mail/taxonomy/folder/child`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: "Child", parentId: parentPayload.item.id }),
      });
      expect(childResponse.status).toBe(200);
      const childPayload = await childResponse.json() as {
        item: { id: string; version: number };
      };

      const invalidLabel = await fetch(`${server.baseUrl}/mail/taxonomy/label/work`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: "Work", parentId: parentPayload.item.id }),
      });
      expect(invalidLabel.status).toBe(400);
      await expect(invalidLabel.json()).resolves.toMatchObject({
        code: "MAIL_TAXONOMY_PARENT_UNSUPPORTED",
      });

      const listed = await fetch(`${server.baseUrl}/mail/taxonomy?kind=folder&limit=1`, {
        headers: AUTHORIZATION,
      });
      expect(listed.status).toBe(200);
      const listedPayload = await listed.json() as {
        items: Array<{ id: string }>;
        nextCursor?: string;
      };
      expect(listedPayload.items.map((item) => item.id)).toEqual([parentPayload.item.id]);
      expect(listedPayload.nextCursor).toBeTruthy();

      const fetched = await fetch(
        `${server.baseUrl}/mail/taxonomy/${encodeURIComponent(childPayload.item.id)}`,
        { headers: AUTHORIZATION },
      );
      expect(fetched.status).toBe(200);
      await expect(fetched.json()).resolves.toMatchObject({
        item: { id: childPayload.item.id, parentId: parentPayload.item.id },
      });

      const stale = await fetch(
        `${server.baseUrl}/mail/taxonomy/${encodeURIComponent(childPayload.item.id)}`,
        {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ expectedVersion: 2, name: "Stale" }),
        },
      );
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toMatchObject({
        code: "MAIL_TAXONOMY_VERSION_CONFLICT",
      });

      const updated = await fetch(
        `${server.baseUrl}/mail/taxonomy/${encodeURIComponent(childPayload.item.id)}`,
        {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            expectedVersion: 1,
            name: "Nested",
            parentId: parentPayload.item.id,
          }),
        },
      );
      expect(updated.status).toBe(200);
      await expect(updated.json()).resolves.toMatchObject({
        item: { name: "Nested", version: 2 },
      });

      const deleted = await fetch(
        `${server.baseUrl}/mail/taxonomy/${encodeURIComponent(parentPayload.item.id)}?expectedVersion=1`,
        { method: "DELETE", headers: AUTHORIZATION },
      );
      expect(deleted.status).toBe(200);
      await expect(deleted.json()).resolves.toMatchObject({
        deleted: { id: parentPayload.item.id, changed: true },
      });

      const reparented = await fetch(
        `${server.baseUrl}/mail/taxonomy/${encodeURIComponent(childPayload.item.id)}`,
        { headers: AUTHORIZATION },
      );
      await expect(reparented.json()).resolves.toMatchObject({
        item: { id: childPayload.item.id },
      });
      expect(((await (await fetch(
        `${server.baseUrl}/mail/taxonomy/${encodeURIComponent(childPayload.item.id)}`,
        { headers: AUTHORIZATION },
      )).json()) as { item: { parentId?: string } }).item.parentId).toBeUndefined();
    } finally {
      await server.close();
      database.close();
    }
  });

  it("fails closed without persistence and rejects malformed taxonomy paths", async () => {
    const server = await createEasyEmailHttpServer(
      new EasyEmailHttpHandler(createEasyEmailService()),
    );
    try {
      const unavailable = await fetch(`${server.baseUrl}/mail/taxonomy?kind=folder`);
      expect(unavailable.status).toBe(503);
      await expect(unavailable.json()).resolves.toMatchObject({
        code: "MAIL_TAXONOMY_PERSISTENCE_UNAVAILABLE",
      });

      const malformed = await fetch(`${server.baseUrl}/mail/taxonomy/%E0%A4%A`);
      expect(malformed.status).toBe(400);
      await expect(malformed.json()).resolves.toMatchObject({ code: "INVALID_MAIL_TAXONOMY" });
    } finally {
      await server.close();
    }
  });
});

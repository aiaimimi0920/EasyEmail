import { describe, expect, it } from "vitest";

import { createEasyEmailService } from "../../src/service/easy-email-service.js";
import { ContactService } from "../../src/service/contacts.js";
import { SqliteRelationalDatabase } from "../../src/persistence/relational/database.js";
import { EasyEmailHttpHandler } from "../../src/http/handler.js";
import { createEasyEmailHttpServer } from "../../src/http/server.js";

const AUTHORIZATION = { authorization: "Bearer contacts-test-token" };

describe("contacts HTTP resources", () => {
  it("dispatches authenticated CRUD, pagination, and conflict semantics", async () => {
    const database = new SqliteRelationalDatabase({ databasePath: ":memory:" });
    let tick = 0;
    const contacts = new ContactService(
      database,
      () => new Date(Date.parse("2026-09-01T09:00:00.000Z") + tick++ * 1000),
    );
    const handler = new EasyEmailHttpHandler(createEasyEmailService(), undefined, contacts);
    const server = await createEasyEmailHttpServer(handler, { apiKey: "contacts-test-token" });

    try {
      const unauthorized = await fetch(`${server.baseUrl}/mail/contacts`);
      expect(unauthorized.status).toBe(401);

      const invalid = await fetch(`${server.baseUrl}/mail/contacts`, {
        method: "POST",
        headers: { ...AUTHORIZATION, "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Invalid" }),
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({ code: "INVALID_CONTACT" });

      const created = await fetch(`${server.baseUrl}/mail/contacts`, {
        method: "POST",
        headers: { ...AUTHORIZATION, "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "  Ada Lovelace  ",
          emailAddress: "Ada@Example.COM",
          note: "  mathematician  ",
        }),
      });
      expect(created.status).toBe(200);
      const createdPayload = await created.json() as {
        contact: { id: string; version: number; emailAddress: string; note: string };
      };
      expect(createdPayload.contact).toMatchObject({
        version: 1,
        emailAddress: "ada@example.com",
        note: "mathematician",
      });

      const upserted = await fetch(`${server.baseUrl}/mail/contacts`, {
        method: "POST",
        headers: { ...AUTHORIZATION, "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Ada Byron",
          emailAddress: "ADA@example.com",
          note: null,
        }),
      });
      expect(upserted.status).toBe(200);
      await expect(upserted.json()).resolves.toMatchObject({
        contact: { id: createdPayload.contact.id, displayName: "Ada Byron", version: 2 },
      });

      const listed = await fetch(`${server.baseUrl}/mail/contacts?limit=1`, {
        headers: AUTHORIZATION,
      });
      expect(listed.status).toBe(200);
      await expect(listed.json()).resolves.toMatchObject({
        contacts: [{ id: createdPayload.contact.id }],
      });

      const fetched = await fetch(
        `${server.baseUrl}/mail/contacts/${encodeURIComponent(createdPayload.contact.id)}`,
        { headers: AUTHORIZATION },
      );
      expect(fetched.status).toBe(200);
      await expect(fetched.json()).resolves.toMatchObject({
        contact: { id: createdPayload.contact.id, version: 2 },
      });

      const updated = await fetch(
        `${server.baseUrl}/mail/contacts/${encodeURIComponent(createdPayload.contact.id)}`,
        {
          method: "PATCH",
          headers: { ...AUTHORIZATION, "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: 2, displayName: "Ada Augusta" }),
        },
      );
      expect(updated.status).toBe(200);
      await expect(updated.json()).resolves.toMatchObject({
        contact: { displayName: "Ada Augusta", version: 3 },
      });

      const stale = await fetch(
        `${server.baseUrl}/mail/contacts/${encodeURIComponent(createdPayload.contact.id)}`,
        {
          method: "PATCH",
          headers: { ...AUTHORIZATION, "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: 1, note: "stale" }),
        },
      );
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toMatchObject({ code: "CONTACT_VERSION_CONFLICT" });

      const malformedDelete = await fetch(
        `${server.baseUrl}/mail/contacts/${encodeURIComponent(createdPayload.contact.id)}?expectedVersion=3x`,
        { method: "DELETE", headers: AUTHORIZATION },
      );
      expect(malformedDelete.status).toBe(400);

      const malformedContactPath = await fetch(
        `${server.baseUrl}/mail/contacts/%E0%A4%A`,
        { headers: AUTHORIZATION },
      );
      expect(malformedContactPath.status).toBe(400);
      await expect(malformedContactPath.json()).resolves.toMatchObject({ code: "INVALID_CONTACT" });

      const malformedQuery = await fetch(
        `${server.baseUrl}/mail/contacts?cursor=%E0%A4%A`,
        { headers: AUTHORIZATION },
      );
      expect(malformedQuery.status).toBe(400);
      await expect(malformedQuery.json()).resolves.toMatchObject({ code: "INVALID_QUERY" });

      const deleted = await fetch(
        `${server.baseUrl}/mail/contacts/${encodeURIComponent(createdPayload.contact.id)}?expectedVersion=3`,
        { method: "DELETE", headers: AUTHORIZATION },
      );
      expect(deleted.status).toBe(200);
      await expect(deleted.json()).resolves.toEqual({
        deleted: { id: createdPayload.contact.id },
      });

      const missing = await fetch(
        `${server.baseUrl}/mail/contacts/${encodeURIComponent(createdPayload.contact.id)}`,
        { headers: AUTHORIZATION },
      );
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
      database.close();
    }
  });

  it("fails closed when the runtime has no persistent contact repository", async () => {
    const server = await createEasyEmailHttpServer(
      new EasyEmailHttpHandler(createEasyEmailService()),
    );
    try {
      const response = await fetch(`${server.baseUrl}/mail/contacts`);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "CONTACTS_PERSISTENCE_UNAVAILABLE",
      });
    } finally {
      await server.close();
    }
  });
});

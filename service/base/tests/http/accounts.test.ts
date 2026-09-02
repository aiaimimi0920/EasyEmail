import { describe, expect, it } from "vitest";

import { EasyEmailHttpHandler } from "../../src/http/handler.js";
import { createEasyEmailHttpServer } from "../../src/http/server.js";
import { SqliteRelationalDatabase } from "../../src/persistence/relational/database.js";
import { createEasyEmailService } from "../../src/service/easy-email-service.js";
import { MailAccountService } from "../../src/service/accounts.js";
import { EasyEmailError } from "../../src/domain/errors.js";

const AUTHORIZATION = { authorization: "Bearer accounts-test-token" };
const JSON_HEADERS = { ...AUTHORIZATION, "content-type": "application/json" };

describe("mail account HTTP resources", () => {
  it("supports authenticated create/list/get/update/disable/delete without raw secrets", async () => {
    const database = new SqliteRelationalDatabase({ databasePath: ":memory:" });
    let credentialMode: "resolved" | "missing" | "unavailable" = "resolved";
    let rejectAuthentication = false;
    const handler = new EasyEmailHttpHandler(
      createEasyEmailService(),
      undefined,
      undefined,
      undefined,
      new MailAccountService(database, () => new Date("2026-09-02T00:00:00Z"), {
        credentialResolver: {
          async resolveCredential() {
            if (credentialMode === "unavailable") throw new Error("broker detail must be hidden");
            return credentialMode === "missing"
              ? { status: "missing" }
              : { status: "resolved", secret: "http-imap-secret-canary" };
          },
        },
        imapTester: {
          async testConnection(profile, secret) {
            expect(profile).toMatchObject({ host: "imap.example.com", security: "tls" });
            expect(secret).toBe("http-imap-secret-canary");
            if (rejectAuthentication) {
              throw new EasyEmailError("IMAP_AUTH_FAILED", "IMAP credentials were rejected.");
            }
            return { authenticated: true, capabilitySummary: "IMAP4rev1 IDLE" };
          },
        },
      }),
    );
    const server = await createEasyEmailHttpServer(handler, { apiKey: "accounts-test-token" });
    try {
      expect((await fetch(`${server.baseUrl}/mail/accounts?scope=normal`)).status).toBe(401);
      const initial = await fetch(`${server.baseUrl}/mail/accounts?scope=normal`, { headers: AUTHORIZATION });
      expect(initial.status).toBe(200);
      await expect(initial.json()).resolves.toMatchObject({
        accounts: [{ id: "acct_anonymous_virtual", scope: "system", kind: "anonymous_virtual" }],
      });

      const rawSecret = await fetch(`${server.baseUrl}/mail/accounts`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          kind: "normal_long_lived",
          displayName: "Leaked",
          primaryAddress: "leaked@example.com",
          password: "raw-secret-canary",
        }),
      });
      expect(rawSecret.status).toBe(400);
      await expect(rawSecret.json()).resolves.toMatchObject({
        code: "ACCOUNT_CREDENTIAL_REF_SECRET_FORBIDDEN",
      });
      const created = await fetch(`${server.baseUrl}/mail/accounts`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          kind: "normal_long_lived",
          displayName: "HTTP Work",
          primaryAddress: "http-work@example.com",
          imap: {
            host: "IMAP.Example.COM",
            port: 993,
            security: "ssl",
            username: "http-work@example.com",
          },
          credentialRefs: [{
            secretBackend: "fake-vault",
            secretKey: "ref:v1:http-work",
            credentialKind: "imap_password",
            authMethod: "password",
          }],
        }),
      });
      expect(created.status).toBe(200);
      const createdPayload = await created.json() as {
        account: { id: string; version: number; credentialRefs: Array<{ id: string }> };
      };
      expect(createdPayload.account).toMatchObject({
        version: 1,
        imap: { protocol: "imap", host: "imap.example.com", security: "tls" },
        credentialRefs: [{ secretKey: "ref:v1:http-work" }],
      });

      const accountId = createdPayload.account.id;
      const fetched = await fetch(
        `${server.baseUrl}/mail/accounts/${encodeURIComponent(accountId)}`,
        { headers: AUTHORIZATION },
      );
      expect(fetched.status).toBe(200);
      await expect(fetched.json()).resolves.toMatchObject({ account: { id: accountId } });

      const credentialRefId = createdPayload.account.credentialRefs[0]!.id;
      const unauthorizedImapTest = await fetch(`${server.baseUrl}/mail/accounts/imap/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId, credentialRefId }),
      });
      expect(unauthorizedImapTest.status).toBe(401);
      const leakedImapTest = await fetch(`${server.baseUrl}/mail/accounts/imap/test`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ accountId, credentialRefId, password: "http-imap-secret-canary" }),
      });
      expect(leakedImapTest.status).toBe(400);
      await expect(leakedImapTest.json()).resolves.toMatchObject({
        code: "ACCOUNT_CREDENTIAL_REF_SECRET_FORBIDDEN",
      });
      const successfulImapTest = await fetch(`${server.baseUrl}/mail/accounts/imap/test`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ accountId, credentialRefId }),
      });
      expect(successfulImapTest.status).toBe(200);
      await expect(successfulImapTest.json()).resolves.toEqual({
        result: { authenticated: true, capabilitySummary: "IMAP4rev1 IDLE" },
      });
      credentialMode = "missing";
      const missingImapCredential = await fetch(`${server.baseUrl}/mail/accounts/imap/test`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ accountId, credentialRefId }),
      });
      expect(missingImapCredential.status).toBe(409);
      await expect(missingImapCredential.json()).resolves.toMatchObject({
        code: "ACCOUNT_REAUTHENTICATION_REQUIRED",
      });
      credentialMode = "unavailable";
      const unavailableImapCredential = await fetch(`${server.baseUrl}/mail/accounts/imap/test`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ accountId, credentialRefId }),
      });
      expect(unavailableImapCredential.status).toBe(503);
      await expect(unavailableImapCredential.json()).resolves.toMatchObject({
        code: "ACCOUNT_CREDENTIAL_UNAVAILABLE",
      });
      credentialMode = "resolved";
      rejectAuthentication = true;
      const rejectedImapCredential = await fetch(`${server.baseUrl}/mail/accounts/imap/test`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ accountId, credentialRefId }),
      });
      expect(rejectedImapCredential.status).toBe(422);
      await expect(rejectedImapCredential.json()).resolves.toMatchObject({ code: "IMAP_AUTH_FAILED" });
      rejectAuthentication = false;
      const updated = await fetch(`${server.baseUrl}/mail/accounts/${encodeURIComponent(accountId)}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ expectedVersion: 1, displayName: "HTTP Work Renamed" }),
      });
      expect(updated.status).toBe(200);
      await expect(updated.json()).resolves.toMatchObject({ account: { version: 2, displayName: "HTTP Work Renamed" } });

      const disabled = await fetch(`${server.baseUrl}/mail/accounts/${encodeURIComponent(accountId)}/disable`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ expectedVersion: 2 }),
      });
      expect(disabled.status).toBe(200);
      await expect(disabled.json()).resolves.toMatchObject({ account: { version: 3, status: "disabled" } });

      const stale = await fetch(`${server.baseUrl}/mail/accounts/${encodeURIComponent(accountId)}?expectedVersion=2`, {
        method: "DELETE",
        headers: AUTHORIZATION,
      });
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toMatchObject({ code: "ACCOUNT_VERSION_CONFLICT" });

      const deleted = await fetch(`${server.baseUrl}/mail/accounts/${encodeURIComponent(accountId)}?expectedVersion=3`, {
        method: "DELETE",
        headers: AUTHORIZATION,
      });
      expect(deleted.status).toBe(200);
      await expect(deleted.json()).resolves.toEqual({ deleted: { id: accountId } });
      expect(JSON.stringify(createdPayload)).not.toContain("raw-secret-canary");
    } finally {
      await server.close();
      database.close();
    }
  });
});

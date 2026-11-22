import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { SqliteMailAccountRepository } from "../../src/persistence/relational/mail-account-repository.js";
import { RELATIONAL_MIGRATIONS } from "../../src/persistence/relational/migrations.js";

function countCredentialRefSelects(database: DatabaseSync) {
  let selectCount = 0;
  const instrumented = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (/\bFROM\s+mail_account_credential_refs\b/i.test(sql)) {
            selectCount += 1;
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DatabaseSync;
  return {
    database: instrumented,
    read: () => selectCount,
    reset: () => { selectCount = 0; },
  };
}

describe("mail account repository query count", () => {
  it("loads credential references once for a page instead of once per account", async () => {
    const rawDatabase = new DatabaseSync(":memory:");
    for (const migration of RELATIONAL_MIGRATIONS) {
      rawDatabase.exec(migration.sql);
    }
    const counter = countCredentialRefSelects(rawDatabase);
    const repository = new SqliteMailAccountRepository(counter.database);
    const now = "2026-09-05T00:00:00.000Z";

    try {
      for (const suffix of ["one", "two"]) {
        await repository.createMailAccount({
          id: `acct_${suffix}`,
          scope: "normal",
          kind: "normal_long_lived",
          displayName: suffix,
          primaryAddress: `${suffix}@example.com`,
          status: "ready",
          authStatus: "valid",
          receiveStatus: "enabled",
          sendStatus: "enabled",
          listedInAllAccounts: true,
          credentialRefs: [{
            secretBackend: "test-vault",
            secretKey: `ref:v1:${suffix}`,
            credentialKind: "imap_password",
            authMethod: "password",
          }],
          now,
        });
      }

      counter.reset();
      const result = await repository.listMailAccounts({ limit: 10 });

      expect(counter.read()).toBe(1);
      expect(result.accounts.map((account) => ({
        id: account.id,
        secretKeys: account.credentialRefs.map((ref) => ref.secretKey),
      }))).toEqual([
        { id: "acct_one", secretKeys: ["ref:v1:one"] },
        { id: "acct_two", secretKeys: ["ref:v1:two"] },
      ]);
    } finally {
      rawDatabase.close();
    }
  });
});

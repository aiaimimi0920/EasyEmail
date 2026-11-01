import worker from "../src/worker";
import type { Env } from "../src/contracts";
import { HttpError } from "../src/http";
import { authenticate, requireWriteScope } from "../src/identity";
import { normalRevision } from "../src/normal-account-input";
import { syncNormalInbox } from "../src/normal-inbox-sync";
import { commitNormalInbox } from "../src/normal-inbox-store";
import { configureImapFixture } from "./normal-imap-transport-fixture";

export default {
  async fetch(request: Request, env: Env & { TEST_IMAP_FIXTURE: string }) {
    configureImapFixture(env.TEST_IMAP_FIXTURE, true);
    const path = new URL(request.url).pathname;
    if (!["/__test/normal-sync", "/__test/normal-commit"].includes(path)) return worker.fetch(request, env);
    try {
      const identity = await authenticate(request, env);
      requireWriteScope(request, env, identity, "mail-accounts:sync");
      if (path === "/__test/normal-commit") {
        const body = await request.json() as { batchId: string };
        const row = await env.DB.prepare(`SELECT b.* FROM normal_inbox_batches b JOIN normal_accounts a ON a.id=b.account_id
          WHERE b.id=? AND a.user_id=?`).bind(body.batchId, identity.userId).first<{
          account_id: string; account_revision: number; from_version: number; source_hash: string;
        }>();
        if (!row) throw new HttpError(404, "not_found");
        const claim = { accountId: row.account_id, revision: row.account_revision, version: row.from_version,
          sourceHash: row.source_hash, token: body.batchId, userId: identity.userId, cursor: null, epochId: null };
        const results = await Promise.all(Array.from({ length: request.headers.has("x-test-parallel") ? 2 : 1 }, () => commitNormalInbox(env, claim)));
        return Response.json(results[0]);
      }
      const body = await request.json() as { accountId: string; expectedRevision: number };
      const bucket = env.INBOX;
      const inbox = bucket && new Proxy(bucket, { get(target, property) {
        if (property === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
          const gate = await fetch(`${env.TEST_IMAP_FIXTURE}/put`, { method: "POST" });
          if (!gate.ok) throw new Error("synthetic-private-storage-error");
          return target.put(...args);
        };
        if (property === "head") return async (key: string) => {
          await fetch(`${env.TEST_IMAP_FIXTURE}/head`, { method: "POST" }); return target.head(key);
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      let batches = 0;
      const db = new Proxy(env.DB, { get(target, property) {
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements);
          if (++batches === 2 && request.headers.has("x-test-lost-batch")) throw new Error("synthetic-lost-committed-response");
          return result;
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      return Response.json(await syncNormalInbox({ ...env, DB: db, INBOX: inbox }, identity, body.accountId, normalRevision(body)));
    } catch (error) {
      return Response.json({ error: { code: error instanceof HttpError ? error.code : "test_unexpected_error" } },
        { status: error instanceof HttpError ? error.status : 500 });
    }
  },
};

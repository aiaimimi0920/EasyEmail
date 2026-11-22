import worker from "../src/worker";
import syncWorker from "./normal-sync-test-worker";
import { configureImapFixture } from "./normal-imap-transport-fixture";
import { cleanupNormalInbox } from "../src/normal-inbox-cleanup";
import type { Env } from "../src/contracts";

export default {
  async fetch(request: Request, env: Env & { TEST_IMAP_FIXTURE: string }) {
    configureImapFixture(env.TEST_IMAP_FIXTURE, true);
    if (new URL(request.url).pathname === "/__test/normal-cleanup") return Response.json(await cleanupNormalInbox(env));
    if (new URL(request.url).pathname === "/__test/normal-scheduled-early-failure") {
      let first = true;
      const db = new Proxy(env.DB, { get(target, key) {
        if (key === "prepare") return (sql: string) => {
          if (first) { first = false; throw new Error("synthetic-early-maintenance-failure"); }
          return target.prepare(sql);
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
      try { await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledController, { ...env, DB: db }); }
      catch { return Response.json({ failed: true }); }
      return Response.json({ failed: false });
    }
    if (new URL(request.url).pathname === "/__test/normal-commit") return syncWorker.fetch(request, env);
    const db = new Proxy(env.DB, { get(target, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        const maintenance = request.url.includes("/admin/retention/run");
        if (maintenance && request.headers.has("x-test-retention-rollback")) {
          return target.batch([...statements, target.prepare("SELECT * FROM synthetic_missing_retention_table")]);
        }
        const result = await target.batch(statements);
        if (maintenance && request.headers.has("x-test-retention-lost")) throw new Error("synthetic-retention-response-lost");
        return result;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const bucket = env.INBOX;
    const inbox = bucket && new Proxy(bucket, { get(target, key) {
      if (key === "delete" && request.headers.has("x-test-retention-delete-fail")) return async () => { throw new Error("synthetic-delete-failure"); };
      if (key === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
        const r = await fetch(`${env.TEST_IMAP_FIXTURE}/put`, { method: "POST" });
        if (!r.ok) throw new Error("synthetic-put-failure"); return target.put(...args);
      };
      if (key === "get") return async (objectKey: string) => {
        const object = await target.get(objectKey), bytes = object && await object.arrayBuffer();
        await fetch(`${env.TEST_IMAP_FIXTURE}/get`, { method: "POST" });
        return object && { size: object.size, arrayBuffer: async () => bytes };
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    return worker.fetch(request, { ...env, DB: db, INBOX: inbox });
  },
  scheduled: worker.scheduled,
};

import worker from "./normal-access-test-worker";
import type { Env } from "../src/contracts";

export default {
  async fetch(request: Request, env: Env & { TEST_IMAP_FIXTURE: string }) {
    const mode = request.headers.get("x-test-folder-storage"), queries = new WeakMap<D1PreparedStatement, string>();
    function statement(target: D1PreparedStatement, sql: string): D1PreparedStatement {
      const wrapped = new Proxy(target, { get(source, property) {
        if (property === "bind") return (...args: unknown[]) => statement(source.bind(...args), sql);
        if (property === "run" && mode === "after-request" && sql.includes("INSERT INTO normal_server_folder_sync_requests")) {
          return async () => { await source.run(); throw new Error("synthetic-lost-request-response"); };
        }
        const value = Reflect.get(source, property); return typeof value === "function" ? value.bind(source) : value;
      } });
      queries.set(wrapped, sql); return wrapped;
    }
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => statement(target.prepare(sql), sql);
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const committing = statements.some(row => (queries.get(row) ?? "").includes("SET status='committed'"));
        if (committing && mode === "before-commit") throw new Error("synthetic-failed-commit");
        const result = await target.batch(statements);
        if (committing && mode === "after-commit") throw new Error("synthetic-lost-commit-response");
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    let put = false;
    const inbox = env.INBOX && new Proxy(env.INBOX, { get(target, property) {
      if (property === "put" && mode === "after-put") return async (...args: Parameters<R2Bucket["put"]>) => {
        const result = await target.put(...args);
        if (!put) { put = true; throw new Error("synthetic-lost-object-response"); } return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    return worker.fetch(request, { ...env, DB: db, INBOX: inbox });
  },
};

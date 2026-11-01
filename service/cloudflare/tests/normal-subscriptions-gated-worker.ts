import worker from "./normal-access-test-worker";
import type { Env } from "../src/contracts";

// Test-only deterministic gates after an empty receipt snapshot or immediately before batch.
export default {
  async fetch(request: Request, env: Env & { TEST_IMAP_FIXTURE: string }) {
    const kind = request.headers.get("x-test-normal-subscription"); let used = false;
    async function pause() { used = true; await fetch(`${env.TEST_IMAP_FIXTURE}/get`, { method: "POST" }); }
    function statement(source: D1PreparedStatement): D1PreparedStatement {
      return new Proxy(source, { get(target, property) {
        if (property === "bind") return (...values: unknown[]) => statement(target.bind(...values));
        if (property === "first") return async (...args: Parameters<D1PreparedStatement["first"]>) => {
          const row = await target.first(...args); if (!used) await pause(); return row;
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
    }
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => kind === "receipt" && sql.includes("SELECT o.*") && sql.includes("FROM normal_subscription_operations")
        ? statement(target.prepare(sql)) : target.prepare(sql);
      if (property === "batch" && kind === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!used) await pause(); return target.batch(statements);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    return worker.fetch(request, { ...env, DB: db });
  },
};

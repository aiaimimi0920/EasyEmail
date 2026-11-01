import accessWorker from "./normal-access-test-worker";
import type { Env } from "../src/contracts";

export default {
  async fetch(request: Request, env: Env & { TEST_IMAP_FIXTURE: string }) {
    let lost = false;
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(s, field) {
          if (field === "bind") return (...values: unknown[]) => wrap(s.bind(...values));
          if (field === "run") return async () => {
            const result = await s.run();
            if (!lost && request.headers.has("x-test-request-insert-lost") && sql.startsWith("INSERT INTO normal_inbox_requests")) {
              lost = true; throw new Error("synthetic-request-insert-response-lost");
            }
            return result;
          };
          const value = Reflect.get(s, field); return typeof value === "function" ? value.bind(s) : value;
        } });
        return wrap(target.prepare(sql));
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    return accessWorker.fetch(request, { ...env, DB: db });
  },
};

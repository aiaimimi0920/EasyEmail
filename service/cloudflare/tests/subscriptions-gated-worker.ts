import worker from "../src/worker";
import type { Env } from "../src/contracts";

// Test-only empty receipt snapshot gate; production writes and batch ordering are unchanged.
export default {
  async fetch(request: Request, env: Env & { TEST_SELECT_GATE: string }): Promise<Response> {
    const gate = request.headers.get("x-test-pause"); if (!gate) return worker.fetch(request, env);
    let used = false;
    function statement(source: D1PreparedStatement): D1PreparedStatement {
      return new Proxy(source, {
        get(target, property) {
          if (property === "bind") return (...values: unknown[]) => statement(target.bind(...values));
          if (property === "first") return async (...args: Parameters<D1PreparedStatement["first"]>) => {
            const row = await target.first(...args);
            if (!used) {
              used = true;
              if (!(await fetch(`${env.TEST_SELECT_GATE}/${encodeURIComponent(gate!)}`)).ok) throw Error("Test gate failed");
            }
            return row;
          };
          const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => sql.includes("SELECT * FROM subscription_operations WHERE user_id=?") ? statement(target.prepare(sql)) : target.prepare(sql);
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return worker.fetch(request, { ...env, DB: db });
  },
};

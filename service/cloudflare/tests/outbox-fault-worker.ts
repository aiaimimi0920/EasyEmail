import worker from "../src/worker";
import type { Env } from "../src/contracts";

// Test-only resource adapter. Production routes and real D1/R2 statements are unchanged.
export default {
  async fetch(request: Request, env: Env & { TEST_SELECT_GATE?: string }): Promise<Response> {
    const fault = request.headers.get("x-test-r2-fault"), gate = request.headers.get("x-test-pause");
    if (!env.OUTBOX || (!fault && !gate)) return worker.fetch(request, env);
    async function pause() {
      const response = await fetch(`${env.TEST_SELECT_GATE}/${encodeURIComponent(gate!)}`);
      if (!response.ok) throw Error("Synthetic resource gate failure");
    }
    const bucket = new Proxy(env.OUTBOX, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (property === fault) throw Error("Synthetic R2 failure");
          if (gate && property === request.headers.get("x-test-r2-gate")) {
            await pause();
          }
          return value.apply(target, args);
        };
      },
    });
    function statement(source: D1PreparedStatement): D1PreparedStatement {
      return new Proxy(source, { get(target, property) {
        if (property === "bind") return (...args: unknown[]) => statement(target.bind(...args));
        if (property === "run") return async () => { await pause(); return target.run(); };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
    }
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => gate && request.headers.get("x-test-d1-gate") === "reservation" && sql.startsWith("INSERT INTO outgoing_messages")
        ? statement(target.prepare(sql)) : target.prepare(sql);
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    return worker.fetch(request, { ...env, OUTBOX: bucket, DB: db });
  },
  scheduled: worker.scheduled,
};

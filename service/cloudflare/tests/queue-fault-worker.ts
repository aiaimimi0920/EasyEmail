import worker from "../src/worker";
import type { Env } from "../src/contracts";

// Test-only D1 transport shim; production statements and real transaction remain in use.
export default {
  fetch: worker.fetch,
  async scheduled(controller: ScheduledController, env: Env & { TEST_QUEUE_FAULT?: string; TEST_QUEUE_GATE?: string }) {
    const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
    const sources = new WeakMap<D1PreparedStatement, string>();
    let used = false;
    function statement(source: D1PreparedStatement, sql: string): D1PreparedStatement {
      const proxy = new Proxy(source, { get(target, property) {
        if (property === "bind") return (...values: unknown[]) => statement(target.bind(...values), sql);
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      originals.set(proxy, source); sources.set(proxy, sql); return proxy;
    }
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => statement(target.prepare(sql), sql);
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const reserve = !used && statements.some(s => sources.get(s)?.startsWith("INSERT INTO outgoing_messages"));
        if (reserve) {
          used = true;
          if (env.TEST_QUEUE_GATE) {
            const gate = await fetch(env.TEST_QUEUE_GATE); if (!gate.ok) throw Error("Synthetic queue gate failed");
          }
        }
        const result = await target.batch(statements.map(s => originals.get(s) ?? s));
        if (reserve && env.TEST_QUEUE_FAULT === "guard-receipt-lost") throw Error("Synthetic post-commit acknowledgement loss");
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    return worker.scheduled(controller, { ...env, DB: db });
  },
};

import worker from "./agent-inbox-test-worker";
import type { Env } from "../src/contracts";

// Gate real SELECT snapshots and optionally lose only the ACK after a real D1 batch commits.
export default {
  fetch(request: Request, env: Env & { TEST_IMAP_FIXTURE: string; TEST_SELECT_GATE: string }) {
    const kind = request.headers.get("x-test-query"), gate = request.headers.get("x-test-pause");
    let used = false, mutation = false;
    function wrap(statement: D1PreparedStatement): D1PreparedStatement {
      return new Proxy(statement, { get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (property === "first" || property === "all") return async (...args: unknown[]) => {
          const result = await (target[property] as (...values: unknown[]) => Promise<unknown>).apply(target, args);
          if (!used && gate) { used = true; if (!(await fetch(`${env.TEST_SELECT_GATE}/${encodeURIComponent(gate)}`)).ok) throw Error("synthetic-thread-gate-failed"); }
          return result;
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
    }
    const DB = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        if (sql.includes("INSERT INTO agent_thread_operations")) mutation = true;
        const selected = kind === "thread-operation" ? sql.startsWith("SELECT * FROM agent_thread_operations") : sql.includes("AS thread_observed_at,w.state AS management_state");
        return selected ? wrap(target.prepare(sql)) : target.prepare(sql);
      };
      if (property === "batch") return async (...args: Parameters<D1Database["batch"]>) => {
        const result = await target.batch(...args);
        if (mutation && request.headers.get("x-test-thread-lost-ack") === "true") throw Error("synthetic-thread-lost-ack"); return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    return worker.fetch(request, { ...env, DB });
  },
};

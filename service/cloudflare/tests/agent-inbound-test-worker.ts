import worker from "./agent-inbox-test-worker";
import type { Env } from "../src/contracts";

// Real D1 snapshots, transactions and constraints; only gates/ACK/fault injection are synthetic.
export default {
  fetch(request: Request, env: Env & { TEST_IMAP_FIXTURE: string; TEST_SELECT_GATE: string }) {
    const kind = request.headers.get("x-test-query"), gate = request.headers.get("x-test-pause");
    let used = false, mutation = false;
    function wrap(statement: D1PreparedStatement): D1PreparedStatement {
      return new Proxy(statement, { get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (property === "first" || property === "all") return async (...args: unknown[]) => {
          const result = await (target[property] as (...values: unknown[]) => Promise<unknown>).apply(target, args);
          if (!used && gate) { used = true; if (!(await fetch(`${env.TEST_SELECT_GATE}/${encodeURIComponent(gate)}`)).ok) throw Error("synthetic-inbound-gate-failed"); }
          return result;
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
    }
    const DB = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        if (sql.includes("INSERT INTO agent_inbound_operations") || sql.includes("INSERT INTO agent_inbound_state_operations")) mutation = true;
        const selected = kind === "inbound-operation" ? sql.startsWith("SELECT * FROM agent_inbound_operations")
          : kind === "inbound-state-operation" ? sql.startsWith("SELECT * FROM agent_inbound_state_operations")
          : kind === "inbound-thread" ? sql.includes("FROM agent_inbound_threads i") : sql.includes("WHERE m.id=? AND m.user_id=?");
        return selected ? wrap(target.prepare(sql)) : target.prepare(sql);
      };
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const extra = mutation && request.headers.get("x-test-inbound-rollback") === "true" ? [target.prepare(
          "INSERT INTO agent_inbound_messages(user_id,thread_id,account_id,message_id,review_revision,created_at) VALUES('missing','missing','missing','missing',0,0)")] : [];
        const result = await target.batch([...statements, ...extra]);
        if (mutation && request.headers.get("x-test-inbound-lost-ack") === "true") throw Error("synthetic-inbound-lost-ack"); return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    return worker.fetch(request, { ...env, DB });
  },
};

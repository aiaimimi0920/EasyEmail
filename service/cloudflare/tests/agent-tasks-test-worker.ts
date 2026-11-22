import worker from "./normal-send-test-worker";
import type { Env } from "../src/contracts";

interface TestEnv extends Env { TEST_SMTP_FIXTURE: string; TEST_AGENT_GATE?: string; TEST_AGENT_FAULT?: string }
function testDatabase(env: TestEnv, request?: Request): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>(), sources = new WeakMap<D1PreparedStatement, string>();
  let gated = false;
  function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      if (property === "first") return async (...args: Parameters<D1PreparedStatement["first"]>) => {
        const row = await target.first(...args);
        if (!gated && request?.headers.has("x-test-agent-gate") && sql.includes("FROM agent_services WHERE")) {
          gated = true; if (!(await fetch(env.TEST_AGENT_GATE!)).ok) throw Error("Synthetic Agent gate failed");
        }
        return row;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }); originals.set(proxy, statement); sources.set(proxy, sql); return proxy;
  }
  return new Proxy(env.DB, { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      const queries = statements.map(statement => sources.get(statement) ?? "");
      const reserve = queries.some(sql => sql.startsWith("UPDATE agent_outgoing_messages SET state='pending'"));
      if (reserve && env.TEST_AGENT_GATE && !request && !gated) { gated = true; if (!(await fetch(env.TEST_AGENT_GATE)).ok) throw Error("Synthetic Agent dispatch gate failed"); }
      if (env.TEST_AGENT_FAULT === "finish" && queries.some(sql => sql.startsWith("UPDATE agent_outgoing_messages SET state=?"))) throw Error("Synthetic Agent finish failure");
      const result = await target.batch(statements.map(statement => originals.get(statement) ?? statement));
      if (reserve && env.TEST_AGENT_FAULT === "receipt-lost") throw Error("Synthetic Agent reservation receipt loss");
      return result;
    };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
}
export default {
  fetch(request: Request, env: TestEnv, context: ExecutionContext) { return worker.fetch(request, { ...env, DB: testDatabase(env, request) }, context); },
  scheduled(controller: ScheduledController, env: TestEnv) { return worker.scheduled(controller, { ...env, DB: testDatabase(env) }); },
};

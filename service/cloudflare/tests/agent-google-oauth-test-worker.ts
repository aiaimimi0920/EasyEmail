import worker from "./google-oauth-test-worker";
import type { Env } from "../src/contracts";
import { agentInboxFaultDatabase } from "./agent-inbox-fault-db";

interface TestEnv extends Env { TEST_AGENT_GOOGLE_FAULT?: string }
function faultDatabase(database: D1Database, fault?: string): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>(), sources = new WeakMap<D1PreparedStatement, string>();
  function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      if (property === "run") return async () => {
        if (fault === "grant-before-stage" && sql.startsWith("INSERT INTO agent_inbox_batches"))
          await database.prepare("UPDATE agent_google_oauth_grants SET state='reauthorize',secret_cipher=NULL,version=version+1").run();
        const result = await target.run();
        if (fault === "refresh-ack" && sql.startsWith("UPDATE agent_google_oauth_grants SET secret_cipher=")) throw Error("synthetic-refresh-ack");
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }); originals.set(proxy, statement); sources.set(proxy, sql); return proxy;
  }
  return new Proxy(database, { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      const queries = statements.map(statement => sources.get(statement) ?? "");
      const task = queries.some(sql => sql.startsWith("UPDATE agent_outgoing_messages SET state='pending'"));
      const followup = queries.some(sql => sql.startsWith("UPDATE agent_followups SET state='pending'"));
      const install = queries.some(sql => sql.startsWith("INSERT INTO agent_google_oauth_grants"));
      if (fault === "grant-before-pending" && (task || followup))
        await database.prepare("UPDATE agent_google_oauth_grants SET state='reauthorize',secret_cipher=NULL,version=version+1").run();
      const result = await target.batch(statements.map(statement => originals.get(statement) ?? statement));
      if (fault === "install-ack" && install || fault === "task-ack" && task || fault === "followup-ack" && followup) throw Error("synthetic-lost-write-ack");
      return result;
    };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
}
function testEnvironment(env: TestEnv, request?: Request) {
  const fault = request?.headers.get("x-test-agent-google-fault") ?? env.TEST_AGENT_GOOGLE_FAULT;
  return { ...env, DB: faultDatabase(agentInboxFaultDatabase(env.DB, fault), fault) };
}
export default {
  fetch(request: Request, env: TestEnv) { return worker.fetch(request, testEnvironment(env, request)); },
  scheduled(controller: ScheduledController, env: TestEnv) { return worker.scheduled(controller, testEnvironment(env)); },
};

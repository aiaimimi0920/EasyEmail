import worker from "../src/worker";
import type { Env } from "../src/contracts";
import { configureSmtpFixture } from "./smtp-transport-fixture";

interface TestEnv extends Env { TEST_SMTP_FIXTURE: string; TEST_FOLLOWUP_FAULT?: string; TEST_FOLLOWUP_GATE?: string }
function fixtureDatabase(env: TestEnv, request?: Request) {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>(), queries = new WeakMap<D1PreparedStatement, string>();
  const fault = request?.headers.get("x-test-followup-fault") ?? env.TEST_FOLLOWUP_FAULT;
  let used = false;
  function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      if (property === "run") return async () => {
        if (fault === "finish" && sql.startsWith("UPDATE agent_followups SET state=?,error_code=?,revision=")) throw Error("Synthetic follow-up finish failure");
        return target.run();
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }); originals.set(proxy, statement); queries.set(proxy, sql); return proxy;
  }
  return new Proxy(env.DB, { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      const sql = statements.map(statement => queries.get(statement) ?? ""), enqueue = sql.some(query => query.startsWith("INSERT INTO agent_followups("));
      const reserve = sql.some(query => query.startsWith("UPDATE agent_followups SET state='pending'"));
      if (!used && (enqueue || reserve)) {
        used = true;
        if (env.TEST_FOLLOWUP_GATE && !(await fetch(env.TEST_FOLLOWUP_GATE)).ok) throw Error("Synthetic follow-up gate failure");
        if (fault === "rollback") throw Error("Synthetic follow-up transaction rollback");
        if (fault === "service-race") await target.prepare("UPDATE agent_services SET version=version+1").run();
        if (fault === "revoke-race") await target.prepare("UPDATE sessions SET revoked_at=unixepoch()").run();
        if (fault === "review-race") await target.prepare(`INSERT INTO agent_incoming_reviews(user_id,account_id,message_id,state,thread_id,revision,updated_at)
          SELECT user_id,account_id,id,'dismissed',NULL,1,unixepoch() FROM agent_incoming_messages WHERE 1
          ON CONFLICT(user_id,account_id,message_id) DO UPDATE SET state='dismissed',thread_id=NULL,revision=revision+1`).run();
        if (fault === "generation-race") await target.prepare("UPDATE agent_inbox_state SET cache_generation=cache_generation+1").run();
        if (fault === "purge-race") await target.prepare("UPDATE agent_incoming_messages SET purged_at=unixepoch()").run();
      }
      const result = await target.batch(statements.map(statement => originals.get(statement) ?? statement));
      if (fault === "enqueue-ack" && enqueue || fault === "reservation-ack" && reserve) throw Error("Synthetic follow-up lost transaction ACK");
      if (fault === "inbox-ack" && sql.some(query => query.startsWith("UPDATE agent_inbox_batches SET state='committed'"))) throw Error("Synthetic inbox commit ACK loss");
      return result;
    };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
}
export default {
  fetch(request: Request, env: TestEnv, _context: ExecutionContext) {
    configureSmtpFixture(env.TEST_SMTP_FIXTURE); return worker.fetch(request, { ...env, DB: fixtureDatabase(env, request) });
  },
  scheduled(controller: ScheduledController, env: TestEnv) {
    configureSmtpFixture(env.TEST_SMTP_FIXTURE); return worker.scheduled(controller, { ...env, DB: fixtureDatabase(env) });
  },
};

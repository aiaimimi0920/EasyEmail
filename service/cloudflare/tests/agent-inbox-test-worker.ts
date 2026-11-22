import worker from "../src/worker";
import type { Env } from "../src/contracts";
import { configureImapFixture } from "./normal-imap-transport-fixture";
import { agentInboxFaultDatabase } from "./agent-inbox-fault-db";

interface TestEnv extends Env { TEST_IMAP_FIXTURE: string; TEST_AGENT_INBOX_FAULT?: string }
function fixtureEnv(env: TestEnv) {
  configureImapFixture(env.TEST_IMAP_FIXTURE, true);
  const inbox = env.INBOX && new Proxy(env.INBOX, { get(target, property) {
    const value = Reflect.get(target, property);
    if (["put", "get", "head", "delete"].includes(String(property))) return async (...args: unknown[]) => {
      const gate = await fetch(`${env.TEST_IMAP_FIXTURE}/${String(property)}`, { method: "POST" });
      if (!gate.ok) throw new Error("synthetic-private-storage-failure");
      const result = await (value as (...args: unknown[]) => unknown).apply(target, args);
      if ((property === "put" || property === "delete") && !(await fetch(`${env.TEST_IMAP_FIXTURE}/after-${String(property)}`, { method: "POST" })).ok) throw new Error("synthetic-lost-storage-ack");
      return result;
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { ...env, INBOX: inbox, DB: agentInboxFaultDatabase(env.DB, env.TEST_AGENT_INBOX_FAULT) };
}
export default {
  fetch(request: Request, env: TestEnv) { return worker.fetch(request, fixtureEnv(env)); },
  scheduled(controller: ScheduledController, env: TestEnv) { return worker.scheduled(controller, fixtureEnv(env)); },
};

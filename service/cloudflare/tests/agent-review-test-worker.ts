import gatedWorker from "./account-gated-worker";
import { configureImapFixture } from "./normal-imap-transport-fixture";
import type { Env } from "../src/contracts";

// Only the ACK is lost: all production D1 statements and the transaction actually execute.
export default {
  fetch(request: Request, env: Env & { TEST_IMAP_FIXTURE: string; TEST_SELECT_GATE: string }) {
    configureImapFixture(env.TEST_IMAP_FIXTURE, true);
    let review = false;
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => { if (sql.includes("INSERT INTO agent_review_operations")) review = true; return target.prepare(sql); };
      if (property === "batch") return async (...args: Parameters<D1Database["batch"]>) => {
        const result = await target.batch(...args);
        if (review && request.headers.get("x-test-review-lost-ack") === "true") throw new Error("synthetic-review-lost-ack");
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    return gatedWorker.fetch(request, { ...env, DB: db });
  },
};

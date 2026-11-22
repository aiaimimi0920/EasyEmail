import worker from "./normal-access-test-worker";
import type { Env } from "../src/contracts";

let consumed = false;
export default {
  async fetch(request: Request, env: Env & { TEST_IMAP_FIXTURE: string; TEST_MUTATION_FAILURE: string }) {
    const injected = (kind: string) => {
      if (consumed || env.TEST_MUTATION_FAILURE !== kind) return false;
      consumed = true; return true;
    };
    function wrap(original: D1PreparedStatement, sql: string): D1PreparedStatement {
      return new Proxy(original, { get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (property === "run") return async () => {
          const insert = /INSERT INTO normal_remote_mutation_operations/.test(sql);
          const dispatch = /UPDATE normal_remote_mutation_operations SET dispatched_at/.test(sql);
          const finish = /UPDATE normal_remote_mutation_operations\s+SET state=/.test(sql);
          const observation = /UPDATE normal_remote_mutation_operations SET destination_uid/.test(sql);
          if ((insert && injected("hold-reserve")) || (dispatch && injected("hold-dispatch"))) await fetch(`${env.TEST_IMAP_FIXTURE}/put`, { method: "POST" });
          if (insert && injected("before-insert") || finish && injected("before-finish")) throw new Error("synthetic database failure");
          const result = await target.run();
          if (observation && injected("hold-after-observation")) await fetch(`${env.TEST_IMAP_FIXTURE}/put`, { method: "POST" });
          if (dispatch && injected("hold-after-dispatch")) await fetch(`${env.TEST_IMAP_FIXTURE}/put`, { method: "POST" });
          if (insert && injected("after-insert") || dispatch && injected("after-dispatch") || finish && injected("after-finish")
            || observation && injected("after-observation")) {
            throw new Error("synthetic lost database response");
          }
          return result;
        };
        const method = Reflect.get(target, property); return typeof method === "function" ? method.bind(target) : method;
      } });
    }
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      const method = Reflect.get(target, property); return typeof method === "function" ? method.bind(target) : method;
    } });
    return worker.fetch(request, { ...env, DB: db });
  },
};

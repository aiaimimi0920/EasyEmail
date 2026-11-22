import worker from "./normal-access-test-worker";
import type { Env } from "../src/contracts";

let consumed = false;
export default {
  async fetch(request: Request, env: Env & { TEST_IMAP_FIXTURE: string; TEST_FLAG_FAILURE: string }) {
    const statements = new WeakMap<object, { original: D1PreparedStatement; sql: string }>();
    const injected = (kind: string) => { if (consumed || env.TEST_FLAG_FAILURE !== kind) return false; consumed = true; return true; };
    function wrap(original: D1PreparedStatement, sql: string): D1PreparedStatement {
      const value = new Proxy(original, { get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (property === "run") return async () => {
          const insert = /INSERT INTO normal_remote_flag_operations/.test(sql), dispatch = /UPDATE normal_remote_flag_operations SET dispatched_at/.test(sql);
          if (insert && injected("hold-reserve")) await fetch(`${env.TEST_IMAP_FIXTURE}/put`, { method: "POST" });
          if (insert && injected("before-insert")) throw new Error("synthetic reservation failure");
          const result = await target.run();
          if (insert && injected("after-insert") || dispatch && injected("after-dispatch")) throw new Error("synthetic lost database response");
          return result;
        };
        const method = Reflect.get(target, property); return typeof method === "function" ? method.bind(target) : method;
      } });
      statements.set(value, { original, sql }); return value;
    }
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch") return async (input: D1PreparedStatement[]) => {
        const finish = input.some(item => /UPDATE normal_remote_flag_operations SET state=/.test(statements.get(item)?.sql ?? ""));
        if (finish && injected("before-finish")) throw new Error("synthetic completion failure");
        const result = await target.batch(input.map(item => statements.get(item)?.original ?? item));
        if (finish && injected("after-finish")) throw new Error("synthetic lost completion response");
        return result;
      };
      const method = Reflect.get(target, property); return typeof method === "function" ? method.bind(target) : method;
    } });
    return worker.fetch(request, { ...env, DB: db });
  },
};

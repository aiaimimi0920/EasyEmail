import worker from "./normal-access-test-worker";
import type { Env } from "../src/contracts";

let consumed = false;
export default {
  async fetch(request: Request, env: Env & { TEST_IMAP_FIXTURE: string; TEST_FOLDER_FAILURE: string }) {
    const statements = new WeakMap<object, D1PreparedStatement>();
    function inject(mode: string) { if (consumed || env.TEST_FOLDER_FAILURE !== mode) return false; consumed = true; return true; }
    function wrap(original: D1PreparedStatement, sql: string): D1PreparedStatement {
      const value = new Proxy(original, { get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (property === "run") return async () => {
          const publish = sql.startsWith("UPDATE normal_server_folder_catalogs SET source_hash=");
          if (publish && inject("before-publish")) throw new Error("synthetic folder publication failure");
          const result = await target.run();
          if (publish && inject("after-publish")) throw new Error("synthetic lost folder publication response");
          return result;
        };
        const method = Reflect.get(target, property); return typeof method === "function" ? method.bind(target) : method;
      } });
      statements.set(value, original); return value;
    }
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch") return async (input: D1PreparedStatement[]) => {
        const result = await target.batch(input.map(item => statements.get(item) ?? item));
        if (inject("after-claim")) throw new Error("synthetic lost folder claim response");
        return result;
      };
      const method = Reflect.get(target, property); return typeof method === "function" ? method.bind(target) : method;
    } });
    return worker.fetch(request, { ...env, DB: db });
  },
};

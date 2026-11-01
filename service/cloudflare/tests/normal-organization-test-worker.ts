import worker from "./normal-access-test-worker";
import type { Env } from "../src/contracts";

export default {
  async fetch(request: Request, env: Env & { TEST_IMAP_FIXTURE: string }) {
    const mode = request.method === "POST" && new URL(request.url).pathname.endsWith("/messages/organize")
      ? request.headers.get("x-test-normal-organization") : null;
    if (!mode) return worker.fetch(request, env);
    const database = new Proxy(env.DB, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (mode === "gate") await fetch(`${env.TEST_IMAP_FIXTURE}/put`, { method: "POST" });
        const result = await target.batch(mode === "rollback" ? [...statements, target.prepare("INSERT INTO synthetic_missing_table VALUES (1)")] : statements);
        if (mode === "lost") throw new Error("synthetic-normal-organization-response-lost");
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    return worker.fetch(request, { ...env, DB: database });
  },
};

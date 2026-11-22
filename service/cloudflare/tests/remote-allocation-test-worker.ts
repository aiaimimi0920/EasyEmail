import worker from "../src/worker";
import type { Env } from "../src/contracts";

// Faults exist only in this test entry. The production entry never imports this module.
function faultDatabase(db: D1Database, fault: string, id: string): D1Database {
  return new Proxy(db, { get(target, property) {
    if (property !== "prepare") {
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    }
    return (sql: string) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (fault === "bind-ack-lost" && property === "run" && sql.startsWith("UPDATE mailbox_creations SET address=")) {
          return async () => { await target.run(); throw new Error("synthetic committed address binding ACK lost"); };
        }
        if (fault === "ack-address-race" && property === "first" && sql.startsWith("UPDATE mailbox_creations SET acknowledged_at=")) {
          return async () => {
            await db.prepare("UPDATE mailbox_creations SET address='confirmed@remote.example.test' WHERE mailbox_id=? AND address LIKE 'remote-random:%'").bind(id).run();
            return target.first();
          };
        }
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      return wrap(target.prepare(sql));
    };
  } });
}

export default { ...worker, fetch(request: Request, env: Env) {
  const fault = request.headers.get("x-test-remote-allocation-fault");
  return worker.fetch(request, fault ? { ...env, DB: faultDatabase(env.DB, fault, new URL(request.url).pathname.split("/")[4] ?? "") } : env);
} };

export function agentInboxFaultDatabase(database: D1Database, fault?: string): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>(), sources = new WeakMap<D1PreparedStatement, string>();
  function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      if (property === "run") return async () => {
        if (fault === "automatic-finish-before" && sql.startsWith("UPDATE agent_inbox_automation SET last_state=")) throw Error("synthetic-automatic-finish-before");
        const result = await target.run();
        if (fault === "insert-ack" && sql.startsWith("INSERT INTO agent_inbox_requests")) throw Error("synthetic-lost-request-ack");
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    originals.set(proxy, statement); sources.set(proxy, sql); return proxy;
  }
  return new Proxy(database, { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      const commit = statements.some(statement => sources.get(statement)?.startsWith("UPDATE agent_inbox_batches SET state='committed'"));
      const reservation = statements.some(statement => sources.get(statement)?.startsWith("UPDATE agent_inbox_automation SET run_token="));
      const claim = statements.some(statement => sources.get(statement)?.startsWith("UPDATE agent_inbox_state SET claim_token="));
      const config = statements.some(statement => sources.get(statement)?.startsWith("UPDATE agent_inbox_automation_operations SET completed_at="));
      const result = await target.batch(statements.map(statement => originals.get(statement) ?? statement));
      if (reservation && fault === "automatic-reservation-ack" || claim && fault === "automatic-claim-ack" || config && fault === "automatic-config-ack") throw Error("synthetic-automatic-lost-ack");
      if (commit && fault === "commit-ack") throw Error("synthetic-lost-commit-ack");
      return result;
    };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
}

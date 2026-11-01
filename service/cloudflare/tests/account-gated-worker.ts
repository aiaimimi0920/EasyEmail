import worker from "../src/worker";
import type { Env } from "../src/contracts";

// Test-only entry: pause after a real D1 SELECT has produced a snapshot.
// Production handlers, KDF, INSERT/UPDATE statements and D1 transactions remain unchanged.
export default {
  async fetch(request: Request, env: Env & { TEST_SELECT_GATE: string }): Promise<Response> {
    const gate = request.headers.get("x-test-pause");
    const kind = request.headers.get("x-test-query");
    if (!gate) return worker.fetch(request, env);
    const gateUrl = `${env.TEST_SELECT_GATE}/${encodeURIComponent(gate)}`;
    const match = kind === "login" ? "SELECT id, username, password_hash, status FROM users WHERE username"
      : kind === "account" ? "u.id,u.username,u.status,u.created_at"
      : kind === "draft" ? "SELECT * FROM drafts WHERE user_id=?"
      : kind === "organization" ? "SELECT * FROM organization_operations WHERE user_id=?" : "SELECT u.id, u.username, s.token_hash";
    const selected = kind === "agent-incoming" ? "WHERE m.id=? AND m.user_id=?"
      : kind === "agent-review-operation" ? "SELECT * FROM agent_review_operations WHERE user_id=?"
      : kind === "contact-operation" ? "SELECT * FROM contact_operations WHERE user_id=?"
      : kind === "agent-smtp-operation" ? "SELECT * FROM agent_smtp_operations WHERE user_id=?"
      : kind === "agent-smtp" ? "SELECT * FROM agent_smtp_configs WHERE user_id=?"
      : kind === "agent-account-operation" ? "SELECT * FROM agent_account_operations WHERE user_id=?"
      : kind === "agent-account" ? "SELECT * FROM agent_accounts WHERE user_id=?"
      : kind === "agent-service-operation" ? "SELECT * FROM agent_service_operations WHERE user_id=?"
      : kind === "agent-service" ? "FROM agent_services WHERE user_id=?"
      : kind === "contact" ? "SELECT * FROM contacts WHERE user_id=?"
      : kind === "folder-parent" ? "SELECT 1 AS valid WHERE" : kind === "folder" ? "SELECT * FROM folders WHERE user_id=?" : match;
    let used = false;
    function statement(source: D1PreparedStatement): D1PreparedStatement {
      return new Proxy(source, {
        get(target, property) {
          if (property === "bind") return (...values: unknown[]) => statement(target.bind(...values));
          if (property === "first") return async (...args: Parameters<D1PreparedStatement["first"]>) => {
            const row = await target.first(...args);
            if (!used) {
              used = true;
              const response = await fetch(gateUrl);
              if (!response.ok) throw Error("Test gate failed");
            }
            return row;
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => sql.includes(selected)
          || kind === "agent-account" && sql.includes("SELECT * FROM agent_google_oauth_accounts WHERE user_id=?")
          ? statement(target.prepare(sql)) : target.prepare(sql);
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return worker.fetch(request, { ...env, DB: db });
  },
};

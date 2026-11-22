import worker from "../src/worker";
import type { Env } from "../src/contracts";
import { configureSmtpFixture } from "./smtp-transport-fixture";
export default {
  async fetch(request: Request, env: Env & { TEST_SMTP_FIXTURE: string }, context: ExecutionContext) {
    configureSmtpFixture(env.TEST_SMTP_FIXTURE);
    const race = request.headers.get("x-test-smtp-race"), fail = request.headers.get("x-test-smtp-finish-failure");
    const accountId = /normal-accounts\/([0-9a-f-]{36})/.exec(new URL(request.url).pathname)?.[1];
    const database = env.DB;
    let mutated = false;
    const mutate = async () => {
      if (!accountId || !race || mutated) return;
      mutated = true;
      const mutations: Record<string, string> = {
        account: "UPDATE normal_accounts SET revision=revision+1 WHERE id=?",
        deleted: "UPDATE normal_accounts SET deleted_at=1 WHERE id=?",
        disabled: "UPDATE normal_accounts SET enabled=0 WHERE id=?",
        smtp: "UPDATE normal_smtp_configs SET revision=revision+1 WHERE account_id=?",
        secret: "UPDATE normal_smtp_configs SET credential_cipher=NULL WHERE account_id=?",
        source: "UPDATE normal_smtp_configs SET endpoint_hash='changed' WHERE account_id=?",
        user: "UPDATE users SET status='disabled' WHERE id=(SELECT user_id FROM normal_accounts WHERE id=?)",
        "draft-edit": "UPDATE drafts SET revision=revision+1,content_hash='changed' WHERE normal_account_id=? AND state='editing'",
        "draft-delete": "UPDATE drafts SET state='deleted',revision=revision+1 WHERE normal_account_id=? AND state='editing'",
        "reply-epoch": "UPDATE normal_inbox_state SET epoch_id='new-epoch' WHERE account_id=?",
        "reply-source": "UPDATE normal_inbox_state SET source_hash='changed-source' WHERE account_id=?",
        "reply-uid": "UPDATE normal_inbox_state SET after_uid=0 WHERE account_id=?",
        "reply-batch": "UPDATE normal_inbox_batches SET status='staged',committed_at=NULL WHERE account_id=?",
        "reply-hash": "UPDATE normal_inbox_messages SET raw_sha256='changed-hash' WHERE account_id=?",
        "reply-content": "UPDATE normal_inbox_messages SET content_sha256='changed-content-hash' WHERE account_id=?",
        "reply-trash": "INSERT INTO normal_message_state(message_id,trashed_at) SELECT id,1 FROM normal_inbox_messages WHERE account_id=?",
        "reply-folder-epoch": "UPDATE normal_server_folder_state SET epoch_id=lower(hex(randomblob(16))) WHERE account_id=?",
        "reply-folder-source": "UPDATE normal_server_folder_state SET source_hash='changed' WHERE account_id=?",
        "reply-folder-generation": "UPDATE normal_server_folder_state SET cache_generation=cache_generation+1 WHERE account_id=?",
        "reply-folder-uid": "UPDATE normal_server_folder_state SET after_uid=0 WHERE account_id=?",
        "reply-folder-wire": "UPDATE normal_server_folder_state SET wire_name='changed' WHERE account_id=?",
        "reply-folder-catalog": "UPDATE normal_server_folder_catalogs SET source_hash='changed' WHERE account_id=?",
        "reply-folder-selectable": "UPDATE normal_server_folder_catalogs SET folders=json_set(folders,'$[0].selectable',json('false')) WHERE account_id=?",
        "reply-folder-batch": "UPDATE normal_inbox_batches SET server_folder_id=NULL WHERE account_id=?",
        "reply-batch-source": "UPDATE normal_inbox_batches SET source_hash='changed' WHERE account_id=?",
        "reply-batch-epoch": "UPDATE normal_inbox_batches SET epoch_id='changed' WHERE account_id=?",
        "reply-folder-owner": "UPDATE normal_inbox_messages SET server_folder_id=NULL WHERE account_id=?",
        "reply-session": "UPDATE sessions SET revoked_at=1 WHERE user_id=(SELECT user_id FROM normal_accounts WHERE id=?)",
        "reply-key": "UPDATE api_keys SET revoked_at=1 WHERE user_id=(SELECT user_id FROM normal_accounts WHERE id=?)",
        "asset-delete": "UPDATE outbox_assets SET state='deleted' WHERE user_id=(SELECT user_id FROM normal_accounts WHERE id=?)",
        "asset-expire": "UPDATE outbox_assets SET expires_at=1 WHERE user_id=(SELECT user_id FROM normal_accounts WHERE id=?)",
        "asset-version": "UPDATE outbox_assets SET version='changed' WHERE user_id=(SELECT user_id FROM normal_accounts WHERE id=?)",
      };
      if (mutations[race]) await database.prepare(mutations[race]).bind(accountId).run();
    };
    const DB = new Proxy(database, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => { await mutate(); return target.batch(statements); };
      if (property !== "prepare") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
      return (query: string) => {
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(stmt, key) {
          if (key === "bind") return (...values: unknown[]) => wrap(stmt.bind(...values));
          if (key === "run") return async () => {
            if (["INSERT INTO normal_outgoing_messages", "INSERT INTO normal_send_jobs", "INSERT INTO drafts", "UPDATE drafts SET revision=revision+1,mailbox_id="].some(prefix => query.startsWith(prefix))) await mutate();
            if (fail && query.startsWith("UPDATE normal_outgoing_messages SET state=?")) throw new Error("synthetic SMTP finish storage failure");
            return stmt.run();
          };
          const value = Reflect.get(stmt, key); return typeof value === "function" ? value.bind(stmt) : value;
        } });
        return wrap(target.prepare(query));
      };
    } });
    const INBOX = env.INBOX && request.headers.has("x-test-reply-raw-race") ? new Proxy(env.INBOX, { get(target, property) {
      if (property === "get") return async (...args: Parameters<R2Bucket["get"]>) => { const object = await target.get(...args); await mutate(); return object; };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) : env.INBOX;
    return worker.fetch(request, { ...env, DB, INBOX }, context);
  },
  async scheduled(controller: ScheduledController, env: Env & { TEST_SMTP_FIXTURE: string; TEST_QUEUE_GATE?: string; TEST_QUEUE_FAULT?: string }) {
    configureSmtpFixture(env.TEST_SMTP_FIXTURE);
    const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>(), sources = new WeakMap<D1PreparedStatement, string>();
    let used = false;
    function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
      const proxy = new Proxy(statement, { get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } }); originals.set(proxy, statement); sources.set(proxy, sql); return proxy;
    }
    const DB = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const reserve = !used && statements.some(statement => sources.get(statement)?.startsWith("INSERT INTO normal_outgoing_messages"));
        if (reserve) {
          used = true;
          if (env.TEST_QUEUE_GATE && !(await fetch(env.TEST_QUEUE_GATE)).ok) throw Error("Synthetic normal queue gate failed");
        }
        const result = await target.batch(statements.map(statement => originals.get(statement) ?? statement));
        if (reserve && env.TEST_QUEUE_FAULT === "guard-receipt-lost") throw Error("Synthetic normal guard acknowledgement loss");
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    return worker.scheduled(controller, { ...env, DB });
  },
};

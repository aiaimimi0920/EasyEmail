import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import {
  evaluateInboxRulesDryRun,
  type InboxRuleActions,
  type InboxRuleCandidateMessage,
  type InboxRuleCondition,
  type InboxRuleDefinition,
} from "../../base/src/domain/mail-inbox-rules";

interface InboxRuleRow {
  id: string;
  user_id: string;
  name: string;
  enabled: number;
  priority: number;
  stop_processing: number;
  conditions_json: string;
  actions_json: string;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

function rowToDefinition(row: InboxRuleRow): InboxRuleDefinition & { version: number } {
  let parsedCond: { matchMode?: "all" | "any"; conditions?: InboxRuleCondition[] } = {};
  let parsedAct: InboxRuleActions = {};
  try {
    parsedCond = JSON.parse(row.conditions_json);
  } catch {
    parsedCond = {};
  }
  try {
    parsedAct = JSON.parse(row.actions_json);
  } catch {
    parsedAct = {};
  }
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    priority: row.priority,
    matchMode: parsedCond.matchMode === "any" ? "any" : "all",
    stopMatching: row.stop_processing === 1,
    conditions: Array.isArray(parsedCond.conditions) ? parsedCond.conditions : [],
    actions: parsedAct,
    version: row.version,
  };
}

async function loadActiveRules(env: Env, userId: string): Promise<Array<InboxRuleDefinition & { version: number }>> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM inbox_rules WHERE user_id = ? AND deleted_at IS NULL ORDER BY priority ASC, created_at ASC",
    )
      .bind(userId)
      .all<InboxRuleRow>();
    return results.map(rowToDefinition);
  } catch {
    throw new HttpError(503, "inbox_rules_schema_required");
  }
}

async function loadRecentCandidates(env: Env, userId: string, windowDays: number): Promise<InboxRuleCandidateMessage[]> {
  const cutoffSec = unixNow() - windowDays * 86400;
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.mailbox_id AS account_id, m.sender, m.subject, substr(m.text_body, 1, 500) AS snippet,
            COALESCE(m.received_at, m.observed_at) AS ts
     FROM messages m
     JOIN mailboxes b ON b.id = m.mailbox_id
     WHERE b.user_id = ? AND m.purged_at IS NULL AND COALESCE(m.received_at, m.observed_at) >= ?
     ORDER BY COALESCE(m.received_at, m.observed_at) DESC
     LIMIT 200`,
  )
    .bind(userId, cutoffSec)
    .all<{ id: string; account_id: string; sender: string; subject: string; snippet: string; ts: number }>();

  return results.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    sender: r.sender,
    subject: r.subject,
    bodySnippet: r.snippet,
    receivedAtMs: r.ts * 1000,
  }));
}

export const isInboxRulesPath = (path: string) =>
  path === "/api/v1/inbox-rules" ||
  path === "/api/v1/inbox-rules/dry-run" ||
  path === "/api/v1/inbox-rules/apply" ||
  path === "/api/v1/inbox-rules/blocklist" ||
  /^\/api\/v1\/inbox-rules\/[0-9a-f-]{36}$/.test(path);

export async function inboxRulesRoute(request: Request, env: Env, identity: Identity): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === "/api/v1/inbox-rules" && request.method === "GET") {
    requireScope(identity, "rules:read");
    const rules = await loadActiveRules(env, identity.userId);
    const { results: blockRows } = await env.DB.prepare(
      "SELECT pattern FROM sender_blocklist WHERE user_id = ? ORDER BY created_at DESC",
    )
      .bind(identity.userId)
      .all<{ pattern: string }>();
    return json({ items: rules, blocklist: blockRows.map((b) => b.pattern) });
  }

  if (path === "/api/v1/inbox-rules" && request.method === "POST") {
    requireWriteScope(request, env, identity, "rules:write");
    const body = await readJson(request);
    const name = String(body.name ?? "").trim();
    if (!name || name.length > 120 || !Array.isArray(body.conditions) || body.conditions.length === 0) {
      throw new HttpError(400, "invalid_inbox_rule_request");
    }
    const id = typeof body.id === "string" && /^[0-9a-f-]{36}$/.test(body.id) ? body.id : crypto.randomUUID();
    const priority = Number.isSafeInteger(body.priority) ? Number(body.priority) : 100;
    const condPayload = JSON.stringify({
      matchMode: body.matchMode === "any" ? "any" : "all",
      conditions: body.conditions.slice(0, 10),
    });
    const actPayload = JSON.stringify(body.actions ?? {});
    const now = unixNow();
    await env.DB.prepare(
      `INSERT INTO inbox_rules (id, user_id, name, enabled, priority, stop_processing, conditions_json, actions_json, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         enabled = excluded.enabled,
         priority = excluded.priority,
         stop_processing = excluded.stop_processing,
         conditions_json = excluded.conditions_json,
         actions_json = excluded.actions_json,
         version = inbox_rules.version + 1,
         updated_at = excluded.updated_at,
         deleted_at = NULL
       WHERE inbox_rules.user_id = excluded.user_id`,
    )
      .bind(
        id,
        identity.userId,
        name,
        body.enabled === false ? 0 : 1,
        priority,
        body.stopMatching === false ? 0 : 1,
        condPayload,
        actPayload,
        now,
        now,
      )
      .run();
    const rules = await loadActiveRules(env, identity.userId);
    return json({ items: rules }, 201);
  }

  const idMatch = /^\/api\/v1\/inbox-rules\/([0-9a-f-]{36})$/.exec(path);
  if (idMatch && request.method === "DELETE") {
    requireWriteScope(request, env, identity, "rules:write");
    const now = unixNow();
    await env.DB.prepare(
      "UPDATE inbox_rules SET enabled = 0, deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND user_id = ?",
    )
      .bind(now, now, idMatch[1]!, identity.userId)
      .run();
    return json({ deleted: true });
  }

  if (path === "/api/v1/inbox-rules/blocklist" && (request.method === "POST" || request.method === "DELETE")) {
    requireWriteScope(request, env, identity, "rules:write");
    const body = await readJson(request);
    const pattern = String(body.pattern ?? "").trim().toLowerCase().replace(/^@/, "");
    if (!pattern || pattern.length > 160) throw new HttpError(400, "invalid_inbox_rule_request");
    if (request.method === "POST") {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO sender_blocklist (user_id, pattern, created_at) VALUES (?, ?, ?)",
      )
        .bind(identity.userId, pattern, unixNow())
        .run();
    } else {
      await env.DB.prepare("DELETE FROM sender_blocklist WHERE user_id = ? AND pattern = ?")
        .bind(identity.userId, pattern)
        .run();
    }
    const { results } = await env.DB.prepare(
      "SELECT pattern FROM sender_blocklist WHERE user_id = ? ORDER BY created_at DESC",
    )
      .bind(identity.userId)
      .all<{ pattern: string }>();
    return json({ blocklist: results.map((r) => r.pattern) });
  }

  if (path === "/api/v1/inbox-rules/dry-run" && request.method === "POST") {
    requireWriteScope(request, env, identity, "rules:read");
    const body = await readJson(request);
    const windowDays = Number.isSafeInteger(body.windowDays) ? Number(body.windowDays) : 30;
    const savedRules = await loadActiveRules(env, identity.userId);
    const draftRules: InboxRuleDefinition[] = Array.isArray(body.draftRules) ? body.draftRules : savedRules;
    const candidates = await loadRecentCandidates(env, identity.userId, windowDays);
    const report = evaluateInboxRulesDryRun(draftRules, candidates, {
      windowDays,
      includeDisabledDraftRule: Array.isArray(body.draftRules),
    });
    return json({ report });
  }

  if (path === "/api/v1/inbox-rules/apply" && request.method === "POST") {
    requireWriteScope(request, env, identity, "rules:write");
    const rules = await loadActiveRules(env, identity.userId);
    const candidates = await loadRecentCandidates(env, identity.userId, 30);
    const report = evaluateInboxRulesDryRun(rules, candidates, { windowDays: 30, maxMatches: 100 });
    const now = unixNow();
    const statements: D1PreparedStatement[] = [];
    for (const match of report.matches) {
      const act = match.plannedActions;
      const sets: string[] = [];
      const vals: Array<number | string> = [];
      if (act.markRead) sets.push("is_read = 1");
      if (act.star) sets.push("starred = 1");
      if (act.archive) sets.push("archived = 1");
      if (act.trash) {
        sets.push("trashed_at = COALESCE(trashed_at, ?)");
        vals.push(now);
      }
      if (sets.length > 0) {
        statements.push(
          env.DB.prepare(
            `UPDATE messages SET ${sets.join(", ")} WHERE id = ? AND mailbox_id IN (SELECT id FROM mailboxes WHERE user_id = ?)`,
          ).bind(...vals, match.messageId, identity.userId),
        );
      }
    }
    if (statements.length > 0) await env.DB.batch(statements);
    return json({ appliedCount: statements.length, report });
  }

  throw new HttpError(405, "method_not_allowed");
}

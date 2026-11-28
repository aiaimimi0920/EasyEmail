import { unixNow, type Env } from "./contracts";
import type { MailContent } from "./providers/contracts";
import {
  evaluateInboxRulesDryRun,
  isSenderBlockedByDomainRule,
  type InboxRuleActions,
  type InboxRuleCondition,
  type InboxRuleDefinition,
} from "../../base/src/domain/mail-inbox-rules";

export interface InboundAutoMailState {
  hasAutoAction: boolean;
  isRead: number;
  starred: number;
  archived: number;
  trashedAt: number | null;
}

const DEFAULT_INBOUND_STATE: InboundAutoMailState = {
  hasAutoAction: false,
  isRead: 0,
  starred: 0,
  archived: 0,
  trashedAt: null,
};

export async function resolveInboundAutoMailState(
  env: Env,
  userId: string,
  mailboxId: string,
  mail: MailContent,
): Promise<InboundAutoMailState> {
  try {
    const [ruleRes, blockRes] = await Promise.all([
      env.DB.prepare(
        "SELECT id, name, enabled, priority, stop_processing, conditions_json, actions_json FROM inbox_rules WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL ORDER BY priority ASC, created_at ASC",
      )
        .bind(userId)
        .all<{
          id: string;
          name: string;
          enabled: number;
          priority: number;
          stop_processing: number;
          conditions_json: string;
          actions_json: string;
        }>(),
      env.DB.prepare("SELECT pattern FROM sender_blocklist WHERE user_id = ?")
        .bind(userId)
        .all<{ pattern: string }>(),
    ]);

    const blockPatterns = blockRes.results.map((r) => r.pattern);
    if (blockPatterns.length > 0 && isSenderBlockedByDomainRule(mail.sender, blockPatterns)) {
      return {
        hasAutoAction: true,
        isRead: 1,
        starred: 0,
        archived: 0,
        trashedAt: unixNow(),
      };
    }

    if (ruleRes.results.length === 0) {
      return DEFAULT_INBOUND_STATE;
    }

    const rules: InboxRuleDefinition[] = ruleRes.results.map((row) => {
      let cond: { matchMode?: "all" | "any"; conditions?: InboxRuleCondition[] } = {};
      let act: InboxRuleActions = {};
      try {
        cond = JSON.parse(row.conditions_json);
      } catch {
        cond = {};
      }
      try {
        act = JSON.parse(row.actions_json);
      } catch {
        act = {};
      }
      return {
        id: row.id,
        name: row.name,
        enabled: true,
        priority: row.priority,
        matchMode: cond.matchMode === "any" ? "any" : "all",
        stopMatching: row.stop_processing === 1,
        conditions: Array.isArray(cond.conditions) ? cond.conditions : [],
        actions: act,
      };
    });

    const nowMs = Date.now();
    const report = evaluateInboxRulesDryRun(
      rules,
      [
        {
          id: "inbound",
          accountId: mailboxId,
          sender: mail.sender,
          subject: mail.subject,
          bodySnippet: mail.textBody.slice(0, 500),
          receivedAtMs: nowMs,
          hasAttachments: mail.attachments.length > 0,
          attachmentFilenames: mail.attachments.map((a) => a.filename),
        },
      ],
      { windowDays: 30, nowMs },
    );
    const match = report.matches[0];
    if (!match) return DEFAULT_INBOUND_STATE;
    const act = match.plannedActions;
    const isRead = act.markRead ? 1 : 0;
    const starred = act.star ? 1 : 0;
    const archived = act.archive ? 1 : 0;
    const trashedAt = act.trash ? unixNow() : null;
    if (!isRead && !starred && !archived && trashedAt === null) {
      return DEFAULT_INBOUND_STATE;
    }
    return {
      hasAutoAction: true,
      isRead,
      starred,
      archived,
      trashedAt,
    };
  } catch {
    return DEFAULT_INBOUND_STATE;
  }
}

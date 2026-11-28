export type InboxRuleMatchMode = "all" | "any";
export type InboxRuleConditionField = "sender" | "sender_domain" | "subject" | "body" | "has_attachment" | "attachment_ext";
export type InboxRuleConditionOperator = "contains" | "equals" | "ends_with" | "not_contains";

export interface InboxRuleCondition {
  field: InboxRuleConditionField;
  operator: InboxRuleConditionOperator;
  value: string;
}

export interface InboxRuleActions {
  addLabelIds?: string[];
  moveToFolderId?: string;
  markRead?: boolean;
  star?: boolean;
  archive?: boolean;
  trash?: boolean;
}

export interface InboxRuleDefinition {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  matchMode: InboxRuleMatchMode;
  accountScope?: string;
  stopMatching: boolean;
  conditions: InboxRuleCondition[];
  actions: InboxRuleActions;
}

export interface InboxRuleCandidateMessage {
  id: string;
  accountId?: string;
  sender: string;
  subject: string;
  bodySnippet?: string;
  receivedAtMs: number;
  hasAttachments?: boolean;
  attachmentFilenames?: readonly string[];
}

export interface InboxRuleDryRunMatch {
  messageId: string;
  subject: string;
  sender: string;
  receivedAtMs: number;
  matchedRuleIds: string[];
  plannedActions: InboxRuleActions;
}

export interface InboxRuleDryRunReport {
  windowDays: number;
  scannedCount: number;
  matchedCount: number;
  matches: InboxRuleDryRunMatch[];
}

const DEFAULT_DRY_RUN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function extractSenderAddressAndDomain(rawSender: string): { address: string; domain: string } {
  const trimmed = rawSender.trim().toLowerCase();
  const angle = /<\s*([^<>@\s]+@([^<>@\s]+))\s*>/.exec(trimmed);
  if (angle?.[1] && angle[2]) {
    return { address: angle[1], domain: angle[2].replace(/\.+$/, "") };
  }
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx >= 0) {
    return { address: trimmed, domain: trimmed.slice(atIdx + 1).replace(/[>\s.]+$/, "") };
  }
  return { address: trimmed, domain: "" };
}

export function isSenderBlockedByDomainRule(senderHeader: string, blockedPatterns: readonly string[]): boolean {
  const { address, domain } = extractSenderAddressAndDomain(senderHeader);
  if (!address && !domain) return false;
  for (const rawPattern of blockedPatterns) {
    const pattern = rawPattern.trim().toLowerCase().replace(/^@/, "").replace(/\.+$/, "");
    if (!pattern) continue;
    if (pattern.includes("@")) {
      if (address === pattern) return true;
    } else if (domain === pattern || domain.endsWith(`.${pattern}`)) {
      return true;
    }
  }
  return false;
}

function evaluateSingleCondition(cond: InboxRuleCondition, msg: InboxRuleCandidateMessage): boolean {
  const needle = cond.value.trim().toLowerCase();
  if (cond.field === "has_attachment") {
    const has = Boolean(msg.hasAttachments || (msg.attachmentFilenames && msg.attachmentFilenames.length > 0));
    return needle === "false" || needle === "0" ? !has : has;
  }
  if (!needle) return false;

  if (cond.field === "attachment_ext") {
    const cleanExt = needle.replace(/^\.+/, "");
    const hit = (msg.attachmentFilenames ?? []).some((name) => name.trim().toLowerCase().endsWith(`.${cleanExt}`));
    return cond.operator === "not_contains" ? !hit : hit;
  }

  const { domain } = extractSenderAddressAndDomain(msg.sender);
  if (cond.field === "sender_domain") {
    const cleanDom = needle.replace(/^@/, "").replace(/\.+$/, "");
    const domainMatch = cond.operator === "equals"
      ? domain === cleanDom
      : domain === cleanDom || domain.endsWith(`.${cleanDom}`);
    return cond.operator === "not_contains" ? !domainMatch : domainMatch;
  }

  const target = cond.field === "sender"
    ? msg.sender.toLowerCase()
    : cond.field === "subject"
      ? msg.subject.toLowerCase()
      : `${msg.subject}\n${msg.bodySnippet ?? ""}`.toLowerCase();

  switch (cond.operator) {
    case "equals":
      return target === needle;
    case "ends_with":
      return target.endsWith(needle);
    case "not_contains":
      return !target.includes(needle);
    case "contains":
    default:
      return target.includes(needle);
  }
}

export function doesInboxRuleMatchMessage(rule: InboxRuleDefinition, msg: InboxRuleCandidateMessage): boolean {
  if (rule.conditions.length === 0) return false;
  if (rule.accountScope && rule.accountScope !== "all" && msg.accountId && rule.accountScope !== msg.accountId) {
    return false;
  }
  return rule.matchMode === "any"
    ? rule.conditions.some((cond) => evaluateSingleCondition(cond, msg))
    : rule.conditions.every((cond) => evaluateSingleCondition(cond, msg));
}

export function mergePlannedRuleActions(base: InboxRuleActions, next: InboxRuleActions): InboxRuleActions {
  const labelSet = new Set([...(base.addLabelIds ?? []), ...(next.addLabelIds ?? [])]);
  return {
    ...(labelSet.size > 0 ? { addLabelIds: [...labelSet] } : {}),
    ...(next.moveToFolderId ?? base.moveToFolderId ? { moveToFolderId: next.moveToFolderId ?? base.moveToFolderId } : {}),
    ...(base.markRead || next.markRead ? { markRead: true } : {}),
    ...(base.star || next.star ? { star: true } : {}),
    ...(base.archive || next.archive ? { archive: true } : {}),
    ...(base.trash || next.trash ? { trash: true } : {}),
  };
}

// Side-effect-free Dry-Run preview over cached messages within a bounded lookback window (default 30 days).
export function evaluateInboxRulesDryRun(
  rules: readonly InboxRuleDefinition[],
  messages: readonly InboxRuleCandidateMessage[],
  options: { nowMs?: number; windowDays?: number; maxMatches?: number; includeDisabledDraftRule?: boolean } = {},
): InboxRuleDryRunReport {
  const windowDays = Math.max(1, Math.min(365, options.windowDays ?? DEFAULT_DRY_RUN_DAYS));
  const cutoffMs = (options.nowMs ?? Date.now()) - windowDays * DAY_MS;
  const maxMatches = Math.max(1, Math.min(200, options.maxMatches ?? 50));

  const activeRules = [...rules]
    .filter((rule) => options.includeDisabledDraftRule || rule.enabled)
    .sort((left, right) => left.priority - right.priority);

  let scannedCount = 0;
  let matchedCount = 0;
  const matches: InboxRuleDryRunMatch[] = [];

  for (const msg of messages) {
    if (msg.receivedAtMs < cutoffMs) continue;
    scannedCount += 1;
    const matchedRuleIds: string[] = [];
    let plannedActions: InboxRuleActions = {};

    for (const rule of activeRules) {
      if (doesInboxRuleMatchMessage(rule, msg)) {
        matchedRuleIds.push(rule.id);
        plannedActions = mergePlannedRuleActions(plannedActions, rule.actions);
        if (rule.stopMatching) break;
      }
    }

    if (matchedRuleIds.length > 0) {
      matchedCount += 1;
      if (matches.length < maxMatches) {
        matches.push({
          messageId: msg.id,
          subject: msg.subject,
          sender: msg.sender,
          receivedAtMs: msg.receivedAtMs,
          matchedRuleIds,
          plannedActions,
        });
      }
    }
  }

  return { windowDays, scannedCount, matchedCount, matches };
}

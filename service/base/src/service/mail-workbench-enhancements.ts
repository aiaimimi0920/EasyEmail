import { randomUUID } from "node:crypto";
import { EasyEmailError } from "../domain/errors.js";
import type { ContactRepository } from "../domain/contact.js";
import {
  evaluateInboxRulesDryRun,
  isSenderBlockedByDomainRule,
  type InboxRuleActions,
  type InboxRuleCandidateMessage,
  type InboxRuleDefinition,
  type InboxRuleDryRunReport,
} from "../domain/mail-inbox-rules.js";
import {
  detectContactDuplicateGroups,
  extractSenderContactCandidates,
  parseVCardContacts,
  planLosslessContactMerge,
  serializeContactsToVCard,
  type ContactDuplicateGroup,
  type ContactMergePlan,
} from "../domain/mail-contact-tools.js";
import {
  buildIcsMethodReply,
  detectCalendarEventConflict,
  parseIcsMeetingInvite,
  type CalendarConflictCheck,
  type CalendarRsvpStatus,
  type ExistingCalendarSlot,
  type ParsedCalendarInvite,
} from "../domain/mail-ics-calendar.js";

export interface OmnimailEnhancementsPersistencePort {
  listInboxRules(): InboxRuleDefinition[];
  upsertInboxRule(rule: InboxRuleDefinition): void;
  deleteInboxRule(id: string): boolean;
  listBlocklist(): string[];
  addBlocklistPattern(pattern: string): void;
  removeBlocklistPattern(pattern: string): void;
  getContactAliasesMap(): Map<string, string[]>;
  replaceContactAliases(contactId: string, aliases: readonly string[]): void;
  deleteContactAliases(contactId: string): void;
  listCalendarEvents(): ExistingCalendarSlot[];
  upsertCalendarEvent(slot: ExistingCalendarSlot & { organizerEmail?: string; sourceRef?: string }): void;
}

export class LocalWorkbenchEnhancementsService {
  private readonly rules = new Map<string, InboxRuleDefinition>();
  private readonly blocklist = new Set<string>();
  private readonly contactAliases = new Map<string, Set<string>>();
  private readonly calendarSlots = new Map<string, ExistingCalendarSlot>();

  public constructor(
    private readonly getContactRepo?: () => ContactRepository | undefined,
    private readonly listRecentMessages?: () => Promise<InboxRuleCandidateMessage[]>,
    private readonly persistence?: OmnimailEnhancementsPersistencePort,
    private readonly applyMessageRuleAction?: (
      messageId: string,
      actions: InboxRuleActions,
    ) => Promise<boolean>,
  ) {
    if (persistence) {
      for (const rule of persistence.listInboxRules()) {
        this.rules.set(rule.id, rule);
      }
      for (const pat of persistence.listBlocklist()) {
        this.blocklist.add(pat);
      }
      for (const [cid, aliases] of persistence.getContactAliasesMap()) {
        this.contactAliases.set(cid, new Set(aliases));
      }
      for (const slot of persistence.listCalendarEvents()) {
        this.calendarSlots.set(slot.uid, slot);
      }
    }
  }

  public listRules(): { items: InboxRuleDefinition[]; blocklist: string[] } {
    const items = [...this.rules.values()].sort((a, b) => a.priority - b.priority);
    return { items, blocklist: [...this.blocklist.values()].sort() };
  }

  public saveRule(input: Partial<InboxRuleDefinition> & { name: string }): InboxRuleDefinition {
    const name = input.name.trim();
    if (!name || !Array.isArray(input.conditions) || input.conditions.length === 0) {
      throw new EasyEmailError("INVALID_INBOX_RULE", "Rule name and at least one condition are required.");
    }
    const id = input.id?.trim() || randomUUID();
    const rule: InboxRuleDefinition = {
      id,
      name,
      enabled: input.enabled !== false,
      priority: Number.isSafeInteger(input.priority) ? Number(input.priority) : 100,
      matchMode: input.matchMode === "any" ? "any" : "all",
      ...(input.accountScope ? { accountScope: input.accountScope } : {}),
      stopMatching: input.stopMatching !== false,
      conditions: input.conditions.slice(0, 10),
      actions: input.actions ?? {},
    };
    this.rules.set(id, rule);
    this.persistence?.upsertInboxRule(rule);
    return rule;
  }

  public deleteRule(ruleId: string): boolean {
    const id = ruleId.trim();
    const mem = this.rules.delete(id);
    const db = this.persistence?.deleteInboxRule(id) ?? false;
    return mem || db;
  }

  public updateBlocklist(pattern: string, remove = false): string[] {
    const clean = pattern.trim().toLowerCase().replace(/^@/, "");
    if (!clean) throw new EasyEmailError("INVALID_INBOX_RULE", "Blocklist pattern is empty.");
    if (remove) {
      this.blocklist.delete(clean);
      this.persistence?.removeBlocklistPattern(clean);
    } else {
      this.blocklist.add(clean);
      this.persistence?.addBlocklistPattern(clean);
    }
    return [...this.blocklist.values()].sort();
  }

  public async previewRulesDryRun(options: {
    windowDays?: number;
    draftRules?: InboxRuleDefinition[];
    messages?: InboxRuleCandidateMessage[];
  } = {}): Promise<InboxRuleDryRunReport> {
    const candidates = options.messages ?? (this.listRecentMessages ? await this.listRecentMessages() : []);
    const activeRules = options.draftRules ?? [...this.rules.values()];
    return evaluateInboxRulesDryRun(activeRules, candidates, {
      windowDays: options.windowDays ?? 30,
      includeDisabledDraftRule: Boolean(options.draftRules),
    });
  }

  public async applyRulesToExistingMessages(windowDays = 30): Promise<{
    appliedCount: number;
    report: InboxRuleDryRunReport;
  }> {
    const candidates = this.listRecentMessages ? await this.listRecentMessages() : [];
    const report = evaluateInboxRulesDryRun([...this.rules.values()], candidates, {
      windowDays,
      maxMatches: 100,
    });
    if (!this.applyMessageRuleAction) {
      return { appliedCount: 0, report };
    }
    const plannedByMessage = new Map<string, InboxRuleActions>();
    for (const match of report.matches) {
      plannedByMessage.set(match.messageId, { ...match.plannedActions });
    }
    const blocklistArr = [...this.blocklist.values()];
    if (blocklistArr.length > 0) {
      for (const msg of candidates) {
        if (isSenderBlockedByDomainRule(msg.sender, blocklistArr)) {
          const prev = plannedByMessage.get(msg.id) ?? {};
          plannedByMessage.set(msg.id, { ...prev, markRead: true, trash: true });
        }
      }
    }
    let appliedCount = 0;
    for (const [messageId, actions] of plannedByMessage) {
      if (await this.applyMessageRuleAction(messageId, actions)) {
        appliedCount += 1;
      }
    }
    return { appliedCount, report };
  }

  private async collectAllContacts() {
    const repo = this.getContactRepo?.();
    if (!repo) return [];
    const res = await repo.listContacts({ limit: 200 });
    return res.contacts.map((c) => ({
      id: c.id,
      displayName: c.displayName,
      emailAddress: c.emailAddress,
      aliases: [...(this.contactAliases.get(c.id) ?? [])],
      notes: c.note,
      revision: c.version,
    }));
  }

  public async findContactDuplicates(): Promise<ContactDuplicateGroup[]> {
    const all = await this.collectAllContacts();
    return detectContactDuplicateGroups(all);
  }

  public async mergeContacts(primaryId: string, secondaryIds: readonly string[]): Promise<ContactMergePlan> {
    const repo = this.getContactRepo?.();
    if (!repo) throw new EasyEmailError("CONTACTS_UNAVAILABLE", "Contact repository is not configured.");
    const all = await this.collectAllContacts();
    const primary = all.find((c) => c.id === primaryId);
    const secondaries = all.filter((c) => secondaryIds.includes(c.id));
    if (!primary || secondaries.length === 0) {
      throw new EasyEmailError("CONTACT_NOT_FOUND", "Primary or secondary contact was not found.");
    }
    const plan = planLosslessContactMerge(primary, secondaries);
    const now = new Date().toISOString();
    await repo.updateContact({
      id: primary.id,
      expectedVersion: primary.revision ?? 1,
      displayName: plan.mergedDisplayName,
      emailAddress: plan.primaryEmailAddress,
      note: plan.mergedNotes || undefined,
      now,
    });
    for (const sec of secondaries) {
      await repo.deleteContact(sec.id, sec.revision ?? 1);
      this.contactAliases.delete(sec.id);
      this.persistence?.deleteContactAliases(sec.id);
    }
    this.contactAliases.set(primary.id, new Set(plan.mergedAliases));
    this.persistence?.replaceContactAliases(primary.id, plan.mergedAliases);
    return plan;
  }

  public async exportContactsVCard(): Promise<{ vcf: string; count: number }> {
    const all = await this.collectAllContacts();
    const vcf = serializeContactsToVCard(
      all.map((c) => ({
        displayName: c.displayName,
        emailAddress: c.emailAddress,
        aliases: c.aliases,
        notes: c.notes,
      })),
    );
    return { vcf, count: all.length };
  }

  public async importContactsVCard(rawVcf: string): Promise<{ importedCount: number }> {
    const repo = this.getContactRepo?.();
    if (!repo) throw new EasyEmailError("CONTACTS_UNAVAILABLE", "Contact repository is not configured.");
    const entries = parseVCardContacts(rawVcf, 200);
    if (entries.length === 0) throw new EasyEmailError("INVALID_VCARD", "No valid vCard entries found.");
    const existingList = await this.collectAllContacts();
    const byEmail = new Map(existingList.map((c) => [c.emailAddress.toLowerCase(), c]));
    const now = new Date().toISOString();
    for (const entry of entries) {
      const note = [entry.organization, entry.title, entry.phone, entry.notes].filter(Boolean).join(" · ") || undefined;
      const existing = byEmail.get(entry.emailAddress.toLowerCase());
      let targetId: string;
      if (existing) {
        const updated = await repo.updateContact({
          id: existing.id,
          expectedVersion: existing.revision ?? 1,
          displayName: entry.displayName || existing.displayName,
          emailAddress: existing.emailAddress,
          note: note ?? existing.notes,
          now,
        });
        targetId = updated.id;
      } else {
        const saved = await repo.createContact({
          id: randomUUID(),
          displayName: entry.displayName,
          emailAddress: entry.emailAddress,
          note,
          now,
        });
        targetId = saved.id;
      }
      if (entry.aliases.length > 0) {
        const set = this.contactAliases.get(targetId) ?? new Set<string>();
        for (const a of entry.aliases) set.add(a);
        this.contactAliases.set(targetId, set);
        this.persistence?.replaceContactAliases(targetId, [...set]);
      }
    }
    return { importedCount: entries.length };
  }

  public async extractContactCandidates(
    senders?: readonly string[],
  ): Promise<Array<{ displayName: string; emailAddress: string }>> {
    const all = await this.collectAllContacts();
    const existing = new Set<string>();
    for (const c of all) {
      existing.add(c.emailAddress.toLowerCase());
      for (const a of c.aliases) existing.add(a.toLowerCase());
    }
    const sourceSenders =
      senders ??
      (this.listRecentMessages ? (await this.listRecentMessages()).map((m) => m.sender) : []);
    return extractSenderContactCandidates(sourceSenders, existing);
  }

  public parseCalendarInvite(rawIcs: string, selfEmail = "", extraText = ""): {
    invite: ParsedCalendarInvite;
    conflict: CalendarConflictCheck;
  } {
    const invite = parseIcsMeetingInvite(rawIcs, selfEmail, extraText);
    if (!invite) throw new EasyEmailError("INVALID_ICS", "Invalid RFC 5545 .ics calendar invite.");
    const existing = [...this.calendarSlots.values()];
    const savedStatus = this.calendarSlots.get(invite.uid)?.status;
    return {
      invite: savedStatus ? { ...invite, selfStatus: savedStatus } : invite,
      conflict: detectCalendarEventConflict(invite, existing),
    };
  }

  public recordCalendarRsvp(input: {
    ics: string;
    responderEmail: string;
    decision: "accepted" | "tentative" | "declined";
  }): {
    savedStatus: CalendarRsvpStatus;
    organizerEmail: string;
    replyDraft: { icsContent: string; subject: string; bodyText: string };
  } {
    const invite = parseIcsMeetingInvite(input.ics, input.responderEmail);
    if (!invite) throw new EasyEmailError("INVALID_ICS", "Invalid RFC 5545 .ics calendar invite.");
    const slot: ExistingCalendarSlot = {
      uid: invite.uid,
      title: invite.title,
      startAtMs: invite.startAtMs,
      endAtMs: invite.endAtMs,
      status: input.decision,
    };
    this.calendarSlots.set(invite.uid, slot);
    this.persistence?.upsertCalendarEvent({
      ...slot,
      organizerEmail: invite.organizerEmail,
    });
    return {
      savedStatus: input.decision,
      organizerEmail: invite.organizerEmail,
      replyDraft: buildIcsMethodReply({
        invite,
        responderEmail: input.responderEmail,
        decision: input.decision,
      }),
    };
  }
}

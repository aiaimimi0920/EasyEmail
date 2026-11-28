import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import os from "node:os";
import type { DatabaseSync } from "node:sqlite";
import type { ExistingCalendarSlot } from "../../domain/mail-ics-calendar.js";
import type {
  InboxRuleActions,
  InboxRuleCondition,
  InboxRuleDefinition,
} from "../../domain/mail-inbox-rules.js";
import type { LocalAiProviderKind, LocalAiStoredState } from "../../service/mail-ai-gateway.js";
import type { StoredWorkBuddyAccount } from "../../service/workbuddy-agent-service.js";

function deriveLocalVaultKey(): Buffer {
  const seed = [
    process.env.EASYEMAIL_LOCAL_VAULT_SECRET ?? "easyemail-local-sqlite-vault-v1",
    os.hostname(),
    (() => {
      try {
        return os.userInfo().username;
      } catch {
        return "local-user";
      }
    })(),
  ].join("|");
  return createHash("sha256").update(seed, "utf8").digest();
}

function sealSecretString(plain: string): string {
  if (!plain) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveLocalVaultKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function openSecretString(stored: string | null | undefined): string {
  if (!stored) return "";
  if (!stored.startsWith("enc:v1:")) return stored;
  const parts = stored.split(":");
  if (parts.length !== 5) return "";
  try {
    const iv = Buffer.from(parts[2] ?? "", "base64");
    const tag = Buffer.from(parts[3] ?? "", "base64");
    const data = Buffer.from(parts[4] ?? "", "base64");
    const decipher = createDecipheriv("aes-256-gcm", deriveLocalVaultKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export class SqliteOmnimailWorkbenchRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public loadAiSettings(): LocalAiStoredState | undefined {
    const row = this.database
      .prepare("SELECT * FROM mail_ai_settings WHERE id = 1")
      .get() as
      | {
          enabled: number;
          provider: string;
          endpoint_url: string;
          model_name: string;
          credential_ref_key: string | null;
          include_subject: number;
          require_consent: number;
          translation_enabled: number;
          translation_provider: string;
          translation_target_lang: string;
          version: number;
          updated_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      enabled: row.enabled === 1,
      provider: row.provider as LocalAiProviderKind,
      endpointUrl: row.endpoint_url,
      modelName: row.model_name,
      apiKey: openSecretString(row.credential_ref_key),
      includeSubject: row.include_subject === 1,
      requireConsent: row.require_consent === 1,
      translationEnabled: row.translation_enabled === 1,
      translationProvider: row.translation_provider === "free" ? "free" : "byok",
      translationTargetLang: row.translation_target_lang,
      version: row.version,
      updatedAt: row.updated_at,
    };
  }

  public saveAiSettings(state: LocalAiStoredState): void {
    const cipherKey = state.apiKey ? sealSecretString(state.apiKey) : null;
    this.database
      .prepare(
        `INSERT INTO mail_ai_settings (
           id, enabled, provider, endpoint_url, model_name, credential_ref_key,
           include_subject, require_consent, translation_enabled, translation_provider,
           translation_target_lang, version, updated_at
         ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled = excluded.enabled,
           provider = excluded.provider,
           endpoint_url = excluded.endpoint_url,
           model_name = excluded.model_name,
           credential_ref_key = excluded.credential_ref_key,
           include_subject = excluded.include_subject,
           require_consent = excluded.require_consent,
           translation_enabled = excluded.translation_enabled,
           translation_provider = excluded.translation_provider,
           translation_target_lang = excluded.translation_target_lang,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.enabled ? 1 : 0,
        state.provider,
        state.endpointUrl,
        state.modelName,
        cipherKey,
        state.includeSubject ? 1 : 0,
        state.requireConsent ? 1 : 0,
        state.translationEnabled ? 1 : 0,
        state.translationProvider,
        state.translationTargetLang,
        state.version,
        state.updatedAt,
      );
  }

  public listWorkBuddyAccounts(): StoredWorkBuddyAccount[] {
    const rows = this.database
      .prepare("SELECT * FROM mail_workbuddy_accounts ORDER BY created_at DESC")
      .all() as Array<{
      id: string;
      alias_id: string;
      email_address: string;
      display_name: string;
      domain: string;
      base_url: string;
      mailbox_status: string;
      credential_json: string;
      daily_limit: number;
      daily_remaining: number;
      daily_reset: number;
      updated_at: string;
    }>;
    const out: StoredWorkBuddyAccount[] = [];
    for (const r of rows) {
      let creds: {
        accessToken?: string;
        refreshToken?: string;
        uid?: string;
        enterpriseId?: string;
        tenantId?: string;
      } = {};
      try {
        creds = JSON.parse(openSecretString(r.credential_json) || "{}");
      } catch {
        creds = {};
      }
      if (!creds.accessToken || !creds.uid) continue;
      out.push({
        id: r.id,
        aliasId: r.alias_id,
        emailAddress: r.email_address,
        displayName: r.display_name,
        domain: r.domain,
        baseUrl: r.base_url,
        mailboxStatus: r.mailbox_status,
        dailyQuota: {
          limit: r.daily_limit,
          remaining: r.daily_remaining,
          reset: r.daily_reset,
          hasQuota: r.daily_limit > 0 || r.daily_remaining > 0 || r.daily_reset > 0,
        },
        updatedAt: r.updated_at,
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken ?? "",
        uid: creds.uid,
        enterpriseId: creds.enterpriseId,
        tenantId: creds.tenantId,
      });
    }
    return out;
  }

  public upsertWorkBuddyAccount(account: StoredWorkBuddyAccount): void {
    const sealed = sealSecretString(
      JSON.stringify({
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        uid: account.uid,
        enterpriseId: account.enterpriseId,
        tenantId: account.tenantId,
      }),
    );
    const now = account.updatedAt || new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO mail_workbuddy_accounts (
           id, alias_id, email_address, display_name, domain, base_url, mailbox_status,
           credential_json, daily_limit, daily_remaining, daily_reset, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           alias_id = excluded.alias_id,
           email_address = excluded.email_address,
           display_name = excluded.display_name,
           domain = excluded.domain,
           base_url = excluded.base_url,
           mailbox_status = excluded.mailbox_status,
           credential_json = excluded.credential_json,
           daily_limit = excluded.daily_limit,
           daily_remaining = excluded.daily_remaining,
           daily_reset = excluded.daily_reset,
           version = mail_workbuddy_accounts.version + 1,
           updated_at = excluded.updated_at`,
      )
      .run(
        account.id,
        account.aliasId,
        account.emailAddress,
        account.displayName,
        account.domain,
        account.baseUrl,
        account.mailboxStatus,
        sealed,
        account.dailyQuota.limit,
        account.dailyQuota.remaining,
        account.dailyQuota.reset,
        now,
        now,
      );
  }

  public deleteWorkBuddyAccount(id: string): boolean {
    const res = this.database.prepare("DELETE FROM mail_workbuddy_accounts WHERE id = ?").run(id);
    return Number(res.changes ?? 0) > 0;
  }

  public listInboxRules(): InboxRuleDefinition[] {
    const rows = this.database
      .prepare("SELECT * FROM mail_inbox_rules ORDER BY priority ASC, created_at ASC, id ASC")
      .all() as Array<{
      id: string;
      name: string;
      enabled: number;
      priority: number;
      stop_processing: number;
      conditions_json: string;
      actions_json: string;
    }>;
    return rows.map((r) => {
      let cond: { matchMode?: "all" | "any"; accountScope?: string; conditions?: InboxRuleCondition[] } = {};
      let act: InboxRuleActions = {};
      try {
        cond = JSON.parse(r.conditions_json);
      } catch {
        cond = {};
      }
      try {
        act = JSON.parse(r.actions_json);
      } catch {
        act = {};
      }
      return {
        id: r.id,
        name: r.name,
        enabled: r.enabled === 1,
        priority: r.priority,
        matchMode: cond.matchMode === "any" ? "any" : "all",
        ...(cond.accountScope ? { accountScope: cond.accountScope } : {}),
        stopMatching: r.stop_processing === 1,
        conditions: Array.isArray(cond.conditions) ? cond.conditions : [],
        actions: act,
      };
    });
  }

  public upsertInboxRule(rule: InboxRuleDefinition): void {
    const now = new Date().toISOString();
    const condJson = JSON.stringify({
      matchMode: rule.matchMode,
      accountScope: rule.accountScope,
      conditions: rule.conditions,
    });
    const actJson = JSON.stringify(rule.actions);
    this.database
      .prepare(
        `INSERT INTO mail_inbox_rules (
           id, name, enabled, priority, stop_processing, conditions_json, actions_json, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           enabled = excluded.enabled,
           priority = excluded.priority,
           stop_processing = excluded.stop_processing,
           conditions_json = excluded.conditions_json,
           actions_json = excluded.actions_json,
           version = mail_inbox_rules.version + 1,
           updated_at = excluded.updated_at`,
      )
      .run(
        rule.id,
        rule.name,
        rule.enabled ? 1 : 0,
        rule.priority,
        rule.stopMatching ? 1 : 0,
        condJson,
        actJson,
        now,
        now,
      );
  }

  public deleteInboxRule(id: string): boolean {
    const res = this.database.prepare("DELETE FROM mail_inbox_rules WHERE id = ?").run(id);
    return Number(res.changes ?? 0) > 0;
  }

  public listBlocklist(): string[] {
    const rows = this.database
      .prepare("SELECT pattern FROM mail_sender_blocklist ORDER BY pattern ASC")
      .all() as Array<{ pattern: string }>;
    return rows.map((r) => r.pattern);
  }

  public addBlocklistPattern(pattern: string): void {
    this.database
      .prepare("INSERT OR IGNORE INTO mail_sender_blocklist (pattern, created_at) VALUES (?, ?)")
      .run(pattern, new Date().toISOString());
  }

  public removeBlocklistPattern(pattern: string): void {
    this.database.prepare("DELETE FROM mail_sender_blocklist WHERE pattern = ?").run(pattern);
  }

  public getContactAliasesMap(): Map<string, string[]> {
    const rows = this.database
      .prepare("SELECT alias_email, contact_id FROM mail_contact_aliases ORDER BY alias_email ASC")
      .all() as Array<{ alias_email: string; contact_id: string }>;
    const map = new Map<string, string[]>();
    for (const r of rows) {
      const list = map.get(r.contact_id) ?? [];
      list.push(r.alias_email);
      map.set(r.contact_id, list);
    }
    return map;
  }

  public replaceContactAliases(contactId: string, aliases: readonly string[]): void {
    this.database.prepare("DELETE FROM mail_contact_aliases WHERE contact_id = ?").run(contactId);
    const now = new Date().toISOString();
    const stmt = this.database.prepare(
      `INSERT INTO mail_contact_aliases (alias_email, contact_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(alias_email) DO UPDATE SET contact_id = excluded.contact_id`,
    );
    for (const alias of aliases) {
      stmt.run(alias.toLowerCase(), contactId, now);
    }
  }

  public deleteContactAliases(contactId: string): void {
    this.database.prepare("DELETE FROM mail_contact_aliases WHERE contact_id = ?").run(contactId);
  }

  public listCalendarEvents(): ExistingCalendarSlot[] {
    const rows = this.database
      .prepare("SELECT uid, title, start_at_ms, end_at_ms, rsvp_status FROM mail_calendar_events")
      .all() as Array<{
      uid: string;
      title: string;
      start_at_ms: number;
      end_at_ms: number;
      rsvp_status: ExistingCalendarSlot["status"];
    }>;
    return rows.map((r) => ({
      uid: r.uid,
      title: r.title,
      startAtMs: r.start_at_ms,
      endAtMs: r.end_at_ms,
      status: r.rsvp_status,
    }));
  }

  public upsertCalendarEvent(slot: ExistingCalendarSlot & { organizerEmail?: string; sourceRef?: string }): void {
    this.database
      .prepare(
        `INSERT INTO mail_calendar_events (
           uid, source_ref, title, organizer_email, start_at_ms, end_at_ms, rsvp_status, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET
           title = excluded.title,
           organizer_email = excluded.organizer_email,
           start_at_ms = excluded.start_at_ms,
           end_at_ms = excluded.end_at_ms,
           rsvp_status = excluded.rsvp_status,
           updated_at = excluded.updated_at`,
      )
      .run(
        slot.uid,
        slot.sourceRef ?? "",
        slot.title,
        slot.organizerEmail ?? "",
        slot.startAtMs,
        slot.endAtMs,
        slot.status,
        new Date().toISOString(),
      );
  }
}

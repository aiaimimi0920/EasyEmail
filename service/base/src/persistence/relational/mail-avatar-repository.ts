import type { DatabaseSync } from "node:sqlite";

import type {
  MailAvatarCachedRecord,
  MailAvatarContactLookup,
  MailAvatarRepository,
  MailAvatarSaveCacheInput,
  MailAvatarSaveFailedCacheInput,
  MailAvatarSenderAuth,
  MailAvatarSettings,
  MailContactAvatarOverrideRecord,
  MailContactAvatarUpsertInput,
} from "../../domain/mail-avatar.js";

export const DEFAULT_MAIL_AVATAR_SETTINGS: MailAvatarSettings = {
  remoteEnabled: true,
  bimiEnabled: true,
  faviconEnabled: true,
  authEnabled: true,
};

export function createDefaultSenderAuth(): MailAvatarSenderAuth {
  return {
    spf: { status: "unknown", detail: "SPF not checked" },
    dkim: { status: "unknown", detail: "DKIM requires Authentication-Results or DKIM headers" },
    dmarc: { status: "unknown", detail: "DMARC not checked" },
    bimi: { status: "unknown", detail: "BIMI not checked" },
    certificate: { status: "unknown", detail: "BIMI certificate not checked" },
  };
}

interface RawAvatarSettingsRow {
  remote_enabled: number;
  bimi_enabled: number;
  favicon_enabled: number;
  auth_enabled: number;
}

interface RawCachedAvatarRow {
  cache_key: string;
  sender_domain: string;
  normalized_sender: string;
  source_kind: string;
  image_mime: string | null;
  image_bytes: Uint8Array | null;
  remote_url: string | null;
  fallback_text: string;
  status: "ok" | "failed";
  auth_json: string;
  last_error: string | null;
  fetched_at: string;
  expires_at: string;
}

interface RawContactOverrideRow {
  sender_key: string;
  contact_id: string | null;
  normalized_sender: string;
  sender_domain: string;
  image_mime: string;
  image_bytes: Uint8Array;
  display_name: string;
  updated_at: string;
}

function parseSenderAuthJson(rawJson: string): MailAvatarSenderAuth {
  try {
    const parsed = JSON.parse(rawJson) as Partial<MailAvatarSenderAuth>;
    const fallback = createDefaultSenderAuth();
    return {
      spf: parsed.spf ?? fallback.spf,
      dkim: parsed.dkim ?? fallback.dkim,
      dmarc: parsed.dmarc ?? fallback.dmarc,
      bimi: parsed.bimi ?? fallback.bimi,
      certificate: parsed.certificate ?? fallback.certificate,
    };
  } catch {
    return createDefaultSenderAuth();
  }
}

export class SqliteMailAvatarRepository implements MailAvatarRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public async getAvatarSettings(): Promise<MailAvatarSettings> {
    const row = this.database.prepare(`
      SELECT remote_enabled, bimi_enabled, favicon_enabled, auth_enabled
      FROM mail_avatar_settings
      WHERE singleton_id = 1
    `).get() as unknown as RawAvatarSettingsRow | undefined;
    if (!row) {
      return { ...DEFAULT_MAIL_AVATAR_SETTINGS };
    }
    return {
      remoteEnabled: row.remote_enabled === 1,
      bimiEnabled: row.bimi_enabled === 1,
      faviconEnabled: row.favicon_enabled === 1,
      authEnabled: row.auth_enabled === 1,
    };
  }

  public async saveAvatarSettings(
    settings: MailAvatarSettings,
    now: string,
  ): Promise<MailAvatarSettings> {
    this.database.prepare(`
      INSERT INTO mail_avatar_settings (
        singleton_id, remote_enabled, bimi_enabled, favicon_enabled, auth_enabled, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton_id) DO UPDATE SET
        remote_enabled = excluded.remote_enabled,
        bimi_enabled = excluded.bimi_enabled,
        favicon_enabled = excluded.favicon_enabled,
        auth_enabled = excluded.auth_enabled,
        updated_at = excluded.updated_at
    `).run(
      settings.remoteEnabled ? 1 : 0,
      settings.bimiEnabled ? 1 : 0,
      settings.faviconEnabled ? 1 : 0,
      settings.authEnabled ? 1 : 0,
      now,
    );
    return this.getAvatarSettings();
  }

  public async clearAvatarCache(includeContacts: boolean): Promise<number> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const cacheResult = this.database.prepare("DELETE FROM mail_sender_avatar_cache").run();
      let deleted = Number(cacheResult.changes);
      if (includeContacts) {
        const contactResult = this.database.prepare("DELETE FROM mail_contact_avatar_overrides").run();
        deleted += Number(contactResult.changes);
      }
      this.database.exec("COMMIT");
      return deleted;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure.
      }
      throw error;
    }
  }

  public async lookupContactForAvatar(
    contactId: string,
  ): Promise<MailAvatarContactLookup | undefined> {
    const row = this.database.prepare(`
      SELECT id, display_name, email_address
      FROM contacts
      WHERE id = ?
      LIMIT 1
    `).get(contactId) as unknown as
      | { id: string; display_name: string; email_address: string }
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      displayName: row.display_name,
      emailAddress: row.email_address,
    };
  }

  public async getContactAvatarOverride(
    senderKey: string,
  ): Promise<MailContactAvatarOverrideRecord | undefined> {
    const row = this.database.prepare(`
      SELECT sender_key, contact_id, normalized_sender, sender_domain,
             image_mime, image_bytes, display_name, updated_at
      FROM mail_contact_avatar_overrides
      WHERE sender_key = ?
    `).get(senderKey) as unknown as RawContactOverrideRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      senderKey: row.sender_key,
      ...(row.contact_id ? { contactId: row.contact_id } : {}),
      normalizedSender: row.normalized_sender,
      senderDomain: row.sender_domain,
      imageMime: row.image_mime,
      imageBytes: new Uint8Array(row.image_bytes),
      displayName: row.display_name,
      updatedAt: row.updated_at,
    };
  }

  public async upsertContactAvatarOverride(
    input: MailContactAvatarUpsertInput,
  ): Promise<MailContactAvatarOverrideRecord> {
    this.database.prepare(`
      INSERT INTO mail_contact_avatar_overrides (
        sender_key, contact_id, normalized_sender, sender_domain,
        image_mime, image_bytes, display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sender_key) DO UPDATE SET
        contact_id = COALESCE(excluded.contact_id, mail_contact_avatar_overrides.contact_id),
        normalized_sender = excluded.normalized_sender,
        sender_domain = excluded.sender_domain,
        image_mime = excluded.image_mime,
        image_bytes = excluded.image_bytes,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
    `).run(
      input.senderKey,
      input.contactId ?? null,
      input.normalizedSender,
      input.senderDomain,
      input.imageMime,
      input.imageBytes,
      input.displayName,
      input.now,
      input.now,
    );
    const saved = await this.getContactAvatarOverride(input.senderKey);
    if (!saved) {
      throw new Error("Contact avatar override upsert did not return a row.");
    }
    return saved;
  }

  public async deleteContactAvatarOverride(senderKey: string): Promise<boolean> {
    const result = this.database.prepare(`
      DELETE FROM mail_contact_avatar_overrides WHERE sender_key = ?
    `).run(senderKey);
    return Number(result.changes) > 0;
  }

  public async getCachedSenderAvatar(
    cacheKey: string,
  ): Promise<MailAvatarCachedRecord | undefined> {
    const row = this.database.prepare(`
      SELECT cache_key, sender_domain, normalized_sender, source_kind,
             image_mime, image_bytes, remote_url, fallback_text, status,
             auth_json, last_error, fetched_at, expires_at
      FROM mail_sender_avatar_cache
      WHERE cache_key = ?
    `).get(cacheKey) as unknown as RawCachedAvatarRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      cacheKey: row.cache_key,
      senderDomain: row.sender_domain,
      normalizedSender: row.normalized_sender,
      sourceKind: row.source_kind,
      ...(row.image_mime ? { imageMime: row.image_mime } : {}),
      ...(row.image_bytes ? { imageBytes: new Uint8Array(row.image_bytes) } : {}),
      ...(row.remote_url ? { remoteUrl: row.remote_url } : {}),
      fallbackText: row.fallback_text,
      status: row.status,
      auth: parseSenderAuthJson(row.auth_json),
      ...(row.last_error ? { lastError: row.last_error } : {}),
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
    };
  }

  public async saveCachedSenderAvatar(input: MailAvatarSaveCacheInput): Promise<void> {
    this.database.prepare(`
      INSERT INTO mail_sender_avatar_cache (
        cache_key, sender_domain, normalized_sender, source_kind, image_mime, image_bytes,
        remote_url, fallback_text, status, auth_json, last_error, fetched_at, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, NULL, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        sender_domain = excluded.sender_domain,
        normalized_sender = excluded.normalized_sender,
        source_kind = excluded.source_kind,
        image_mime = excluded.image_mime,
        image_bytes = excluded.image_bytes,
        remote_url = excluded.remote_url,
        fallback_text = excluded.fallback_text,
        status = 'ok',
        auth_json = excluded.auth_json,
        last_error = NULL,
        fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(
      input.cacheKey,
      input.senderDomain,
      input.normalizedSender,
      input.sourceKind,
      input.imageMime,
      input.imageBytes,
      input.remoteUrl,
      input.fallbackText,
      JSON.stringify(input.auth),
      input.fetchedAt,
      input.expiresAt,
      input.fetchedAt,
      input.fetchedAt,
    );
  }

  public async saveFailedSenderAvatar(input: MailAvatarSaveFailedCacheInput): Promise<void> {
    this.database.prepare(`
      INSERT INTO mail_sender_avatar_cache (
        cache_key, sender_domain, normalized_sender, source_kind, image_mime, image_bytes,
        remote_url, fallback_text, status, auth_json, last_error, fetched_at, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'failed', NULL, NULL, NULL, ?, 'failed', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        source_kind = 'failed',
        image_mime = NULL,
        image_bytes = NULL,
        remote_url = NULL,
        fallback_text = excluded.fallback_text,
        status = 'failed',
        auth_json = excluded.auth_json,
        last_error = excluded.last_error,
        fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(
      input.cacheKey,
      input.senderDomain,
      input.normalizedSender,
      input.fallbackText,
      JSON.stringify(input.auth),
      input.lastError.slice(0, 512),
      input.fetchedAt,
      input.expiresAt,
      input.fetchedAt,
      input.fetchedAt,
    );
  }
}

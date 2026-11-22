import { EasyEmailError } from "../domain/errors.js";
import type {
  MailAvatarClearCacheInput,
  MailAvatarClearCacheResult,
  MailAvatarRepository,
  MailAvatarResolveInput,
  MailAvatarSettings,
  MailAvatarSettingsUpdateInput,
  MailContactAvatarClearResult,
  MailContactAvatarSetInput,
  MailSenderAvatar,
} from "../domain/mail-avatar.js";
import { createDefaultSenderAuth } from "../persistence/relational/mail-avatar-repository.js";
import { assertOnlyKnownFields } from "./account-validation.js";
import {
  cachedAvatarSatisfiesPolicy,
  fetchRemoteSenderAvatarWithPolicy,
  normalizeSenderIdentityForAvatar,
  resolveDomainAuthSignals,
  type NormalizedSenderIdentity,
} from "./avatar-identity-and-remote.js";
import {
  formatAvatarDataUrl,
  isPublicDnsName,
  MAX_CONTACT_AVATAR_BYTES,
  NodeSafeAvatarHttpFetcher,
  parseAndValidateAvatarDataUrl,
  type AvatarRemoteFetcher,
} from "./avatar-network.js";

export { normalizeSenderIdentityForAvatar } from "./avatar-identity-and-remote.js";

const SUCCESS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_UNIQUE_SENDERS_PER_REQUEST = 16;

const SETTINGS_UPDATE_FIELDS = new Set([
  "remoteEnabled",
  "bimiEnabled",
  "faviconEnabled",
  "authEnabled",
]);
const RESOLVE_FIELDS = new Set(["senders"]);
const CONTACT_AVATAR_SET_FIELDS = new Set(["imageDataUrl", "sender"]);
const CLEAR_CACHE_FIELDS = new Set(["includeContacts"]);

export class MailAvatarService {
  private readonly remoteFetcher: AvatarRemoteFetcher;

  public constructor(
    private readonly repository: MailAvatarRepository,
    private readonly now: () => Date = () => new Date(),
    options: { remoteFetcher?: AvatarRemoteFetcher } = {},
  ) {
    this.remoteFetcher = options.remoteFetcher ?? new NodeSafeAvatarHttpFetcher();
  }

  public async getAvatarSettings(): Promise<MailAvatarSettings> {
    return this.repository.getAvatarSettings();
  }

  public async updateAvatarSettings(
    input: MailAvatarSettingsUpdateInput,
  ): Promise<MailAvatarSettings> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_AVATAR_REQUEST", "Avatar settings request must be an object.");
    }
    assertOnlyKnownFields(
      input as unknown as Record<string, unknown>,
      SETTINGS_UPDATE_FIELDS,
      "Avatar settings",
    );
    const current = await this.repository.getAvatarSettings();
    const resolveBool = (val: unknown, fallback: boolean, name: string): boolean => {
      if (val === undefined) return fallback;
      if (typeof val !== "boolean") {
        throw new EasyEmailError("INVALID_AVATAR_REQUEST", `${name} must be a boolean.`);
      }
      return val;
    };
    const next: MailAvatarSettings = {
      remoteEnabled: resolveBool(input.remoteEnabled, current.remoteEnabled, "remoteEnabled"),
      bimiEnabled: resolveBool(input.bimiEnabled, current.bimiEnabled, "bimiEnabled"),
      faviconEnabled: resolveBool(input.faviconEnabled, current.faviconEnabled, "faviconEnabled"),
      authEnabled: resolveBool(input.authEnabled, current.authEnabled, "authEnabled"),
    };
    return this.repository.saveAvatarSettings(next, this.now().toISOString());
  }

  public async clearAvatarCache(
    input: MailAvatarClearCacheInput = {},
  ): Promise<MailAvatarClearCacheResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_AVATAR_REQUEST", "Avatar cache clear request must be an object.");
    }
    assertOnlyKnownFields(
      input as unknown as Record<string, unknown>,
      CLEAR_CACHE_FIELDS,
      "Avatar cache clear",
    );
    if (input.includeContacts !== undefined && typeof input.includeContacts !== "boolean") {
      throw new EasyEmailError("INVALID_AVATAR_REQUEST", "includeContacts must be a boolean.");
    }
    const deletedCount = await this.repository.clearAvatarCache(Boolean(input.includeContacts));
    return { deletedCount };
  }

  private async resolveContactTarget(
    contactIdOrSender: string,
    explicitSender?: string | null,
  ): Promise<{ contactId?: string; identity: NormalizedSenderIdentity }> {
    const trimmedKey = contactIdOrSender.trim();
    if (!trimmedKey) {
      throw new EasyEmailError("INVALID_AVATAR_REQUEST", "contactId is required.");
    }
    const existingContact = await this.repository.lookupContactForAvatar(trimmedKey);
    if (existingContact) {
      const formatted = explicitSender?.trim()
        || `${existingContact.displayName} <${existingContact.emailAddress}>`;
      return {
        contactId: existingContact.id,
        identity: normalizeSenderIdentityForAvatar(formatted),
      };
    }
    if (trimmedKey.startsWith("ct_v1_")) {
      throw new EasyEmailError("CONTACT_NOT_FOUND", `Contact ${trimmedKey} was not found.`);
    }
    return {
      identity: normalizeSenderIdentityForAvatar(explicitSender?.trim() || trimmedKey),
    };
  }

  public async setContactAvatar(
    contactId: string,
    input: MailContactAvatarSetInput,
  ): Promise<MailSenderAvatar> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_AVATAR_REQUEST", "Contact avatar request must be an object.");
    }
    assertOnlyKnownFields(
      input as unknown as Record<string, unknown>,
      CONTACT_AVATAR_SET_FIELDS,
      "Contact avatar",
    );
    if (typeof input.imageDataUrl !== "string" || !input.imageDataUrl.trim()) {
      throw new EasyEmailError("INVALID_AVATAR_DATA_URL", "imageDataUrl is required.");
    }
    if (input.sender !== undefined && input.sender !== null && typeof input.sender !== "string") {
      throw new EasyEmailError("INVALID_AVATAR_REQUEST", "sender must be a string when provided.");
    }
    const { contactId: resolvedContactId, identity } = await this.resolveContactTarget(
      contactId,
      input.sender,
    );
    const { mime, bytes } = parseAndValidateAvatarDataUrl(input.imageDataUrl, MAX_CONTACT_AVATAR_BYTES);
    const nowIso = this.now().toISOString();
    const saved = await this.repository.upsertContactAvatarOverride({
      senderKey: identity.cacheKey,
      contactId: resolvedContactId,
      normalizedSender: identity.normalizedSender,
      senderDomain: identity.domain,
      imageMime: mime,
      imageBytes: bytes,
      displayName: identity.displayName,
      now: nowIso,
    });
    return {
      sender: identity.raw,
      cacheKey: identity.cacheKey,
      domain: identity.domain,
      displayName: saved.displayName,
      sourceKind: "contact",
      imageDataUrl: formatAvatarDataUrl(saved.imageMime, saved.imageBytes),
      builtinKind: identity.builtinKind ?? null,
      fallbackText: identity.fallbackText,
      remoteUrl: null,
      auth: createDefaultSenderAuth(),
      fetchedAt: saved.updatedAt,
      expiresAt: null,
    };
  }

  public async clearContactAvatar(contactId: string): Promise<MailContactAvatarClearResult> {
    const { identity } = await this.resolveContactTarget(contactId);
    const cleared = await this.repository.deleteContactAvatarOverride(identity.cacheKey);
    return {
      contactId: contactId.trim(),
      cacheKey: identity.cacheKey,
      cleared,
    };
  }

  public async resolveSenderAvatars(input: MailAvatarResolveInput): Promise<MailSenderAvatar[]> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_AVATAR_REQUEST", "Avatar resolve request must be an object.");
    }
    assertOnlyKnownFields(
      input as unknown as Record<string, unknown>,
      RESOLVE_FIELDS,
      "Avatar resolve",
    );
    if (!Array.isArray(input.senders) || input.senders.some((s) => typeof s !== "string")) {
      throw new EasyEmailError("INVALID_AVATAR_REQUEST", "senders must be an array of strings.");
    }

    const settings = await this.repository.getAvatarSettings();
    const seenCacheKeys = new Set<string>();
    const results: MailSenderAvatar[] = [];
    const currentNowMs = this.now().getTime();

    for (const rawSender of input.senders.slice(0, MAX_UNIQUE_SENDERS_PER_REQUEST * 3)) {
      if (!rawSender.trim()) continue;
      const identity = normalizeSenderIdentityForAvatar(rawSender);
      if (seenCacheKeys.has(identity.cacheKey)) continue;
      seenCacheKeys.add(identity.cacheKey);
      if (seenCacheKeys.size > MAX_UNIQUE_SENDERS_PER_REQUEST) break;

      const contactOverride = await this.repository.getContactAvatarOverride(identity.cacheKey);
      if (contactOverride) {
        results.push({
          sender: identity.raw,
          cacheKey: identity.cacheKey,
          domain: identity.domain,
          displayName: identity.displayName,
          sourceKind: "contact",
          imageDataUrl: formatAvatarDataUrl(contactOverride.imageMime, contactOverride.imageBytes),
          builtinKind: identity.builtinKind ?? null,
          fallbackText: identity.fallbackText,
          remoteUrl: null,
          auth: createDefaultSenderAuth(),
          fetchedAt: contactOverride.updatedAt,
          expiresAt: null,
        });
        continue;
      }

      const cached = await this.repository.getCachedSenderAvatar(identity.cacheKey);
      if (cached) {
        const expiresMs = Date.parse(cached.expiresAt);
        if (
          !Number.isNaN(expiresMs)
          && expiresMs > currentNowMs
          && cachedAvatarSatisfiesPolicy(identity, cached, settings)
        ) {
          results.push({
            sender: identity.raw,
            cacheKey: identity.cacheKey,
            domain: identity.domain,
            displayName: identity.displayName,
            sourceKind: cached.sourceKind,
            imageDataUrl: cached.imageMime && cached.imageBytes
              ? formatAvatarDataUrl(cached.imageMime, cached.imageBytes)
              : null,
            builtinKind: identity.builtinKind ?? null,
            fallbackText: cached.fallbackText,
            remoteUrl: cached.remoteUrl ?? null,
            auth: cached.auth,
            fetchedAt: cached.fetchedAt,
            expiresAt: cached.expiresAt,
          });
          continue;
        }
      }

      if (!settings.remoteEnabled) {
        results.push({
          sender: identity.raw,
          cacheKey: identity.cacheKey,
          domain: identity.domain,
          displayName: identity.displayName,
          sourceKind: "builtin",
          imageDataUrl: null,
          builtinKind: identity.builtinKind ?? null,
          fallbackText: identity.fallbackText,
          remoteUrl: null,
          auth: createDefaultSenderAuth(),
          fetchedAt: null,
          expiresAt: null,
        });
        continue;
      }

      const fetchedAt = this.now().toISOString();
      try {
        const remote = await fetchRemoteSenderAvatarWithPolicy(
          this.remoteFetcher,
          identity,
          settings,
        );
        const expiresAt = new Date(this.now().getTime() + SUCCESS_TTL_MS).toISOString();
        await this.repository.saveCachedSenderAvatar({
          cacheKey: identity.cacheKey,
          senderDomain: identity.domain,
          normalizedSender: identity.normalizedSender,
          sourceKind: remote.sourceKind,
          imageMime: remote.imageMime,
          imageBytes: remote.imageBytes,
          remoteUrl: remote.remoteUrl,
          fallbackText: identity.fallbackText,
          auth: remote.auth,
          fetchedAt,
          expiresAt,
        });
        results.push({
          sender: identity.raw,
          cacheKey: identity.cacheKey,
          domain: identity.domain,
          displayName: identity.displayName,
          sourceKind: remote.sourceKind,
          imageDataUrl: formatAvatarDataUrl(remote.imageMime, remote.imageBytes),
          builtinKind: identity.builtinKind ?? null,
          fallbackText: identity.fallbackText,
          remoteUrl: remote.remoteUrl,
          auth: remote.auth,
          fetchedAt,
          expiresAt,
        });
      } catch (error) {
        const auth = settings.authEnabled && isPublicDnsName(identity.domain)
          ? await resolveDomainAuthSignals(this.remoteFetcher, identity.domain)
          : createDefaultSenderAuth();
        const expiresAt = new Date(this.now().getTime() + FAILURE_TTL_MS).toISOString();
        const message = error instanceof Error ? error.message : "Avatar fetch failed.";
        await this.repository.saveFailedSenderAvatar({
          cacheKey: identity.cacheKey,
          senderDomain: identity.domain,
          normalizedSender: identity.normalizedSender,
          fallbackText: identity.fallbackText,
          auth,
          lastError: message,
          fetchedAt,
          expiresAt,
        });
        results.push({
          sender: identity.raw,
          cacheKey: identity.cacheKey,
          domain: identity.domain,
          displayName: identity.displayName,
          sourceKind: "failed",
          imageDataUrl: null,
          builtinKind: identity.builtinKind ?? null,
          fallbackText: identity.fallbackText,
          remoteUrl: null,
          auth,
          fetchedAt,
          expiresAt,
        });
      }
    }

    return results;
  }
}

export function createMailAvatarService(
  repository: MailAvatarRepository,
  now?: () => Date,
  options?: { remoteFetcher?: AvatarRemoteFetcher },
): MailAvatarService {
  return new MailAvatarService(repository, now, options);
}

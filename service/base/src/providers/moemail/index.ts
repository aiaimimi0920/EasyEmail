import { createId } from "../../shared/index.js";
import { EasyEmailError } from "../../domain/errors.js";
import type { MailboxSession, ProviderInstance } from "../../domain/models.js";
import type { MailProviderAdapter, ProviderProbeResult } from "../contracts.js";
import { createMailboxLocalPart } from "../local-part.js";
import {
  classifyMoemailFailure,
  MoemailClient,
  decodeMoemailMailboxRef,
  encodeMoemailMailboxRef,
  probeMoemailInstance,
  resolveMoemailConfig,
} from "./client.js";

function createLocalPart(hostId: string, sessionId: string): string {
  return createMailboxLocalPart(hostId, sessionId);
}

function parseDomainPool(raw: string | undefined): string[] {
  const normalized = String(raw ?? "").replace(/[;\r\n|]/g, ",");
  const pool: string[] = [];
  const seen = new Set<string>();
  for (const item of normalized.split(",")) {
    const domain = item.trim().toLowerCase();
    if (!domain || seen.has(domain)) {
      continue;
    }
    seen.add(domain);
    pool.push(domain);
  }
  return pool;
}

function resolveMailboxDomain(instance: ProviderInstance, requestMetadata: Record<string, string> | undefined): string | undefined {
  const requestDomain = requestMetadata?.requestedDomain?.trim() || requestMetadata?.domain?.trim() || "";
  if (requestDomain) {
    return requestDomain;
  }
  const domainPool = parseDomainPool(instance.metadata.domainsCsv || instance.metadata.domains);
  if (domainPool.length > 1) {
    return domainPool[Math.floor(Math.random() * domainPool.length)];
  }
  if (domainPool.length === 1) {
    return domainPool[0];
  }
  const instanceDomain = instance.metadata.domain;
  return instanceDomain && instanceDomain.trim() ? instanceDomain.trim() : undefined;
}

const MOEMAIL_ALLOWED_EXPIRY_VALUES_MS = [0, 3_600_000, 86_400_000, 604_800_000] as const;
const MOEMAIL_DEFAULT_EXPIRY_TIME_MS = 3_600_000;

function normalizeMoemailExpiryTimeMs(value: number | undefined): number | undefined {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return undefined;
  }

  const normalized = Math.trunc(value as number);
  if (normalized === 0) {
    return 0;
  }
  if (normalized <= 0) {
    return undefined;
  }

  for (const candidate of MOEMAIL_ALLOWED_EXPIRY_VALUES_MS) {
    if (candidate > 0 && normalized <= candidate) {
      return candidate;
    }
  }

  return MOEMAIL_ALLOWED_EXPIRY_VALUES_MS[MOEMAIL_ALLOWED_EXPIRY_VALUES_MS.length - 1];
}

function resolveExpiryTime(
  instance: ProviderInstance,
  ttlMinutes: number | undefined,
  requestMetadata: Record<string, string> | undefined,
): number | undefined {
  const explicit = Number.parseInt(String(requestMetadata?.expiryTimeMs || requestMetadata?.expiryTime || instance.metadata.expiryTimeMs || ""), 10);
  if (Number.isFinite(explicit)) {
    return normalizeMoemailExpiryTimeMs(explicit) ?? MOEMAIL_DEFAULT_EXPIRY_TIME_MS;
  }
  if (typeof ttlMinutes === "number" && Number.isFinite(ttlMinutes) && ttlMinutes > 0) {
    return normalizeMoemailExpiryTimeMs(Math.max(60_000, Math.trunc(ttlMinutes * 60 * 1000))) ?? MOEMAIL_DEFAULT_EXPIRY_TIME_MS;
  }
  return MOEMAIL_DEFAULT_EXPIRY_TIME_MS;
}

function parseRequestedEmailAddress(
  requestMetadata: Record<string, string> | undefined,
): { email: string; localPart: string; domain: string } | undefined {
  const raw = requestMetadata?.requestedEmailAddress?.trim().toLowerCase()
    || requestMetadata?.requestedMailboxAddress?.trim().toLowerCase()
    || "";
  if (!raw || !raw.includes("@")) {
    return undefined;
  }
  const parts = raw.split("@");
  if (parts.length !== 2) {
    return undefined;
  }
  const [localPart, domain] = parts.map((item) => item.trim());
  if (!localPart || !domain) {
    return undefined;
  }
  return {
    email: `${localPart}@${domain}`,
    localPart,
    domain,
  };
}

function resolveRequestedMailboxIdentity(
  instance: ProviderInstance,
  requestMetadata: Record<string, string> | undefined,
): { requestedEmail?: string; requestedLocalPart?: string; requestedDomain?: string } {
  const requestedEmail = parseRequestedEmailAddress(requestMetadata);
  if (requestedEmail) {
    return {
      requestedEmail: requestedEmail.email,
      requestedLocalPart: requestedEmail.localPart,
      requestedDomain: requestedEmail.domain,
    };
  }

  const requestedLocalPart = requestMetadata?.requestedLocalPart?.trim() || requestMetadata?.localPart?.trim() || "";
  const requestedDomain = resolveMailboxDomain(instance, requestMetadata);
  return {
    requestedLocalPart: requestedLocalPart || undefined,
    requestedDomain,
  };
}

function mapMoemailCreateMailboxError(error: unknown): EasyEmailError {
  const classified = classifyMoemailFailure(error);
  if (classified.mailboxConflict) {
    return new EasyEmailError("MOEMAIL_MAILBOX_CONFLICT", classified.message);
  }
  if (classified.kind === "capacity") {
    return new EasyEmailError("MOEMAIL_CAPACITY_EXHAUSTED", classified.message);
  }
  if (classified.kind === "auth") {
    return new EasyEmailError("MOEMAIL_AUTH_FAILED", classified.message);
  }
  if (classified.kind === "transient") {
    return new EasyEmailError("MOEMAIL_UPSTREAM_TRANSIENT", classified.message);
  }
  return new EasyEmailError("MOEMAIL_PROVIDER_ERROR", classified.message);
}

export { probeMoemailInstance } from "./client.js";

export class MoemailProviderAdapter implements MailProviderAdapter {
  public readonly typeKey = "moemail" as ProviderInstance["providerTypeKey"];

  public async createMailboxSession(
    { request, instance, credentialSets, now }: Parameters<MailProviderAdapter["createMailboxSession"]>[0],
  ): Promise<MailboxSession> {
    const sessionId = createId("mailbox", now);
    const client = MoemailClient.fromInstance(instance, credentialSets);
    if (!client) {
      throw new EasyEmailError(
        "MOEMAIL_CONFIGURATION_MISSING",
        `MoEmail instance ${instance.id} is missing credentialSets/apiKey/keysFile configuration.`,
      );
    }

    const requestedIdentity = resolveRequestedMailboxIdentity(instance, request.metadata);

    let mailbox;
    try {
      mailbox = await client.createMailbox({
        // Pass the full requested email when available so conflict recovery can
        // reclaim or recreate the exact provider-side mailbox on 409.
        name: requestedIdentity.requestedEmail
          || requestedIdentity.requestedLocalPart
          || createLocalPart(request.hostId, sessionId),
        expiryTime: resolveExpiryTime(instance, request.ttlMinutes, request.metadata),
        domain: requestedIdentity.requestedDomain,
      });
    } catch (error) {
      throw mapMoemailCreateMailboxError(error);
    }

    return {
      id: sessionId,
      hostId: request.hostId,
      providerTypeKey: this.typeKey,
      providerInstanceId: instance.id,
      emailAddress: mailbox.email,
      mailboxRef: encodeMoemailMailboxRef(instance.id, mailbox),
      status: "open",
      createdAt: now.toISOString(),
      expiresAt: request.ttlMinutes
        ? new Date(now.getTime() + request.ttlMinutes * 60 * 1000).toISOString()
        : undefined,
      metadata: { ...(request.metadata ?? {}) },
    };
  }

  public async syncMailboxCode(
    { session, instance, credentialSets }: Parameters<NonNullable<MailProviderAdapter["syncMailboxCode"]>>[0],
  ) {
    const mailbox = decodeMoemailMailboxRef(session.mailboxRef, instance.id);
    if (!mailbox) {
      return undefined;
    }

    const client = MoemailClient.fromInstance(instance, credentialSets);
    if (!client) {
      return undefined;
    }

    return await client.tryReadLatestCode(
      session.id,
      mailbox,
      instance.id,
      session.metadata.fromContains,
    );
  }

  public async recoverMailboxSession(
    { emailAddress, hostId, instance, credentialSets, now }: Parameters<NonNullable<MailProviderAdapter["recoverMailboxSession"]>>[0],
  ) {
    const client = MoemailClient.fromInstance(instance, credentialSets);
    if (!client) {
      return undefined;
    }

    const recovery = await client.recoverMailboxByEmailAddress(emailAddress);
    if (!recovery) {
      return undefined;
    }

    const recoveredExpiryTimeMs = resolveExpiryTime(instance, undefined, undefined);
    return {
      strategy: recovery.strategy,
      session: {
        id: createId("mailbox", now),
        hostId: hostId?.trim() || `recovery:${instance.id}`,
        providerTypeKey: this.typeKey,
        providerInstanceId: instance.id,
        emailAddress: recovery.mailbox.email,
        mailboxRef: encodeMoemailMailboxRef(instance.id, recovery.mailbox),
        status: "open" as const,
        createdAt: now.toISOString(),
        expiresAt: recoveredExpiryTimeMs
          ? new Date(now.getTime() + recoveredExpiryTimeMs).toISOString()
          : undefined,
        metadata: {
          recoveredFromEmailAddress: emailAddress.trim().toLowerCase(),
          recoveryStrategy: recovery.strategy,
          recoverySource: "provider",
        },
      },
      detail: recovery.strategy,
    };
  }

  public async releaseMailboxSession(
    { session, instance, credentialSets }: Parameters<NonNullable<MailProviderAdapter["releaseMailboxSession"]>>[0],
  ) {
    const mailbox = decodeMoemailMailboxRef(session.mailboxRef, instance.id);
    if (!mailbox) {
      return {
        released: false,
        detail: "invalid_mailbox_ref",
      };
    }

    const client = MoemailClient.fromInstance(instance, credentialSets);
    if (!client) {
      return {
        released: false,
        detail: "client_unavailable",
      };
    }

    const maintenanceClient = new MoemailClient(resolveMoemailConfig(instance, credentialSets, {
      namespace: `mail:moemail:maintenance:${instance.id}`,
    }));
    return await maintenanceClient.deleteMailbox(mailbox.emailId, "poll");
  }

  public async probeInstance(
    { instance, credentialSets }: Parameters<MailProviderAdapter["probeInstance"]>[0],
  ): Promise<ProviderProbeResult> {
    return await probeMoemailInstance(instance, credentialSets.length > 0 ? credentialSets : undefined);
  }
}

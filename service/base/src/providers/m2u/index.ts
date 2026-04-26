import { createId } from "../../shared/index.js";
import type { MailboxSession } from "../../domain/models.js";
import type { MailProviderAdapter, ProviderProbeResult } from "../contracts.js";
import {
  M2uClient,
  decodeM2uMailboxRef,
  encodeM2uMailboxRef,
  probeM2uInstance,
} from "./client.js";

export { probeM2uInstance } from "./client.js";

export class M2uProviderAdapter implements MailProviderAdapter {
  public readonly typeKey = "m2u" as const;

  public async createMailboxSession(
    { request, instance, now }: Parameters<MailProviderAdapter["createMailboxSession"]>[0],
  ): Promise<MailboxSession> {
    const sessionId = createId("mailbox", now);
    const client = M2uClient.fromInstance(instance);
    const mailbox = await client.createMailbox({
      // Keep generic high-availability routing provider-neutral. Only honor a
      // domain preference when the caller explicitly requested one.
      preferredDomain: request.requestedDomain?.trim() || "",
      requestedLocalPart: request.requestedLocalPart?.trim() || "",
      turnstileToken: request.turnstileToken?.trim() || "",
    });

    return {
      id: sessionId,
      hostId: request.hostId,
      providerTypeKey: this.typeKey,
      providerInstanceId: instance.id,
      emailAddress: mailbox.email,
      mailboxRef: encodeM2uMailboxRef(instance.id, mailbox),
      status: "open",
      createdAt: now.toISOString(),
      expiresAt: mailbox.expiresAt
        ?? (request.ttlMinutes ? new Date(now.getTime() + request.ttlMinutes * 60 * 1000).toISOString() : undefined),
      metadata: { ...(request.metadata ?? {}) },
    };
  }

  public async syncMailboxCode(
    { session, instance }: Parameters<NonNullable<MailProviderAdapter["syncMailboxCode"]>>[0],
  ) {
    const mailbox = decodeM2uMailboxRef(session.mailboxRef, instance.id);
    if (!mailbox) {
      return undefined;
    }

    const client = M2uClient.fromInstance(instance);
    return await client.tryReadLatestCode(
      session.id,
      mailbox,
      instance.id,
      session.metadata.fromContains,
    );
  }

  public async recoverMailboxSession(
    { emailAddress, hostId, instance, now, session }: Parameters<NonNullable<MailProviderAdapter["recoverMailboxSession"]>>[0],
  ) {
    if (!session) {
      return undefined;
    }

    const mailbox = decodeM2uMailboxRef(session.mailboxRef, instance.id);
    if (!mailbox) {
      return undefined;
    }

    const normalizedRequestedEmail = emailAddress.trim().toLowerCase();
    if (!normalizedRequestedEmail || mailbox.email.trim().toLowerCase() !== normalizedRequestedEmail) {
      return undefined;
    }

    const metadata: Record<string, string> = {
      ...session.metadata,
      recoveredFromEmailAddress: normalizedRequestedEmail,
      recoveryStrategy: "session_restore",
      recoverySource: "provider_session_restore",
      previousSessionId: session.id,
      notBeforeAt: now.toISOString(),
    };
    delete metadata.lastCodeObservedAt;
    delete metadata.lastCodeMessageId;
    delete metadata.releasedAt;
    delete metadata.releaseReason;
    delete metadata.releaseStatus;
    delete metadata.releaseDetail;

    return {
      strategy: "session_restore" as const,
      session: {
        id: createId("mailbox", now),
        hostId: hostId?.trim() || session.hostId,
        providerTypeKey: this.typeKey,
        providerInstanceId: instance.id,
        emailAddress: mailbox.email,
        mailboxRef: encodeM2uMailboxRef(instance.id, mailbox),
        status: "open" as const,
        createdAt: now.toISOString(),
        expiresAt: mailbox.expiresAt ?? session.expiresAt,
        metadata,
      },
      detail: "session_restore",
    };
  }

  public async probeInstance(
    { instance }: Parameters<MailProviderAdapter["probeInstance"]>[0],
  ): Promise<ProviderProbeResult> {
    return await probeM2uInstance(instance);
  }
}

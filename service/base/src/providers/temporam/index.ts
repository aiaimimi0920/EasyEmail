import { createId } from "../../shared/index.js";
import type { MailboxSession } from "../../domain/models.js";
import type { MailProviderAdapter, ProviderProbeResult } from "../contracts.js";
import {
  TemporamClient,
  decodeTemporamMailboxRef,
  encodeTemporamMailboxRef,
  probeTemporamInstance,
} from "./client.js";

export { probeTemporamInstance } from "./client.js";

export class TemporamProviderAdapter implements MailProviderAdapter {
  public readonly typeKey = "temporam" as const;

  public async createMailboxSession(
    { request, instance, now }: Parameters<MailProviderAdapter["createMailboxSession"]>[0],
  ): Promise<MailboxSession> {
    const sessionId = createId("mailbox", now);
    const client = TemporamClient.fromInstance(instance);
    const mailbox = await client.createMailbox({
      preferredDomain: request.requestedDomain?.trim() || "",
      requestedLocalPart: request.requestedLocalPart?.trim() || "",
    });

    return {
      id: sessionId,
      hostId: request.hostId,
      providerTypeKey: this.typeKey,
      providerInstanceId: instance.id,
      emailAddress: mailbox.email,
      mailboxRef: encodeTemporamMailboxRef(instance.id, mailbox),
      status: "open",
      createdAt: now.toISOString(),
      expiresAt: request.ttlMinutes
        ? new Date(now.getTime() + request.ttlMinutes * 60 * 1000).toISOString()
        : undefined,
      metadata: {
        ...(request.metadata ?? {}),
        selectedDomain: mailbox.domain,
        anonymousWebFlow: "true",
      },
    };
  }

  public async syncMailboxCode(
    { session, instance }: Parameters<NonNullable<MailProviderAdapter["syncMailboxCode"]>>[0],
  ) {
    const mailbox = decodeTemporamMailboxRef(session.mailboxRef, instance.id);
    if (!mailbox) {
      return undefined;
    }

    const client = TemporamClient.fromInstance(instance);
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

    const mailbox = decodeTemporamMailboxRef(session.mailboxRef, instance.id);
    if (!mailbox) {
      return undefined;
    }

    const normalizedRequestedEmail = emailAddress.trim().toLowerCase();
    if (!normalizedRequestedEmail || mailbox.email.trim().toLowerCase() !== normalizedRequestedEmail) {
      return undefined;
    }

    const metadata: Record<string, string> = {
      ...session.metadata,
      selectedDomain: mailbox.domain,
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
        mailboxRef: encodeTemporamMailboxRef(instance.id, mailbox),
        status: "open" as const,
        createdAt: now.toISOString(),
        expiresAt: session.expiresAt,
        metadata,
      },
      detail: "session_restore",
    };
  }

  public async probeInstance(
    { instance }: Parameters<MailProviderAdapter["probeInstance"]>[0],
  ): Promise<ProviderProbeResult> {
    return await probeTemporamInstance(instance);
  }
}

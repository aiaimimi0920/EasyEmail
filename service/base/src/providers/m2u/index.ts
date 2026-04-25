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
      preferredDomain: request.requestedDomain,
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

  public async probeInstance(
    { instance }: Parameters<MailProviderAdapter["probeInstance"]>[0],
  ): Promise<ProviderProbeResult> {
    return await probeM2uInstance(instance);
  }
}

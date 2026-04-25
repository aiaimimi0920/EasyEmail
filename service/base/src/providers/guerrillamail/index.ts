import { createId } from "../../shared/index.js";
import type { MailboxSession, ProviderInstance } from "../../domain/models.js";
import type { MailProviderAdapter, ProviderProbeResult } from "../contracts.js";
import { createMailboxLocalPart } from "../local-part.js";
import {
  decodeGuerrillaMailMailboxRef,
  encodeGuerrillaMailMailboxRef,
  GuerrillaMailClient,
  probeGuerrillaMailInstance,
} from "./client.js";

function createLocalPart(hostId: string, sessionId: string): string {
  return createMailboxLocalPart(hostId, sessionId);
}

export { probeGuerrillaMailInstance } from "./client.js";

export class GuerrillaMailProviderAdapter implements MailProviderAdapter {
  public readonly typeKey = "guerrillamail" as ProviderInstance["providerTypeKey"];

  public async createMailboxSession(
    { request, instance, now }: Parameters<MailProviderAdapter["createMailboxSession"]>[0],
  ): Promise<MailboxSession> {
    const sessionId = createId("mailbox", now);
    const client = GuerrillaMailClient.fromInstance(instance);
    const mailbox = await client.createMailbox({
      suggestedEmailUser: createLocalPart(request.hostId, sessionId),
    });

    return {
      id: sessionId,
      hostId: request.hostId,
      providerTypeKey: this.typeKey,
      providerInstanceId: instance.id,
      emailAddress: mailbox.emailAddress,
      mailboxRef: encodeGuerrillaMailMailboxRef(instance.id, mailbox),
      status: "open",
      createdAt: now.toISOString(),
      expiresAt: request.ttlMinutes
        ? new Date(now.getTime() + request.ttlMinutes * 60 * 1000).toISOString()
        : undefined,
      metadata: { ...(request.metadata ?? {}) },
    };
  }

  public async syncMailboxCode(
    { session, instance }: Parameters<NonNullable<MailProviderAdapter["syncMailboxCode"]>>[0],
  ) {
    const mailbox = decodeGuerrillaMailMailboxRef(session.mailboxRef, instance.id);
    if (!mailbox) {
      return undefined;
    }

    const client = GuerrillaMailClient.fromInstance(instance);
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
    return await probeGuerrillaMailInstance(instance);
  }
}

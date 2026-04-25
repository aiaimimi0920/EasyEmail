import { createId } from "../../shared/index.js";
import type { MailboxSession } from "../../domain/models.js";
import type { MailProviderAdapter, ProviderProbeResult } from "../contracts.js";
import {
  EtempmailClient,
  decodeEtempmailMailboxRef,
  encodeEtempmailMailboxRef,
  probeEtempmailInstance,
} from "./client.js";

const ETEMPMAIL_DEFAULT_TTL_MS = 20 * 60 * 1000;

function resolveSessionExpiresAt(
  now: Date,
  ttlMinutes: number | undefined,
): string {
  const requestedExpiryMs = typeof ttlMinutes === "number" && Number.isFinite(ttlMinutes) && ttlMinutes > 0
    ? now.getTime() + ttlMinutes * 60 * 1000
    : now.getTime() + ETEMPMAIL_DEFAULT_TTL_MS;
  return new Date(Math.min(now.getTime() + ETEMPMAIL_DEFAULT_TTL_MS, requestedExpiryMs)).toISOString();
}

export { probeEtempmailInstance } from "./client.js";

export class EtempmailProviderAdapter implements MailProviderAdapter {
  public readonly typeKey = "etempmail" as const;

  public async createMailboxSession(
    { request, instance, now }: Parameters<MailProviderAdapter["createMailboxSession"]>[0],
  ): Promise<MailboxSession> {
    const sessionId = createId("mailbox", now);
    const client = EtempmailClient.fromInstance(instance);
    const mailbox = await client.createMailbox({
      requestedDomain: request.requestedDomain,
    });

    return {
      id: sessionId,
      hostId: request.hostId,
      providerTypeKey: this.typeKey,
      providerInstanceId: instance.id,
      emailAddress: mailbox.email,
      mailboxRef: encodeEtempmailMailboxRef(instance.id, mailbox),
      status: "open",
      createdAt: now.toISOString(),
      expiresAt: resolveSessionExpiresAt(now, request.ttlMinutes),
      metadata: {
        ...(request.metadata ?? {}),
        selectedDomain: mailbox.email.split("@")[1] || "",
      },
    };
  }

  public async syncMailboxCode(
    { session, instance }: Parameters<NonNullable<MailProviderAdapter["syncMailboxCode"]>>[0],
  ) {
    const mailbox = decodeEtempmailMailboxRef(session.mailboxRef, instance.id);
    if (!mailbox) {
      return undefined;
    }

    const client = EtempmailClient.fromInstance(instance);
    return await client.tryReadLatestCode(
      session.id,
      mailbox,
      instance.id,
      session.metadata.fromContains,
    );
  }

  public async releaseMailboxSession(
    { session, instance }: Parameters<NonNullable<MailProviderAdapter["releaseMailboxSession"]>>[0],
  ) {
    const mailbox = decodeEtempmailMailboxRef(session.mailboxRef, instance.id);
    if (!mailbox) {
      return {
        released: false,
        detail: "invalid_mailbox_ref",
      };
    }

    const client = EtempmailClient.fromInstance(instance);
    return await client.deleteMailbox(mailbox);
  }

  public async probeInstance(
    { instance }: Parameters<MailProviderAdapter["probeInstance"]>[0],
  ): Promise<ProviderProbeResult> {
    return await probeEtempmailInstance(instance);
  }
}

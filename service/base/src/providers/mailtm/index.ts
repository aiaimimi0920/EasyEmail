import { createId } from "../../shared/index.js";
import { createMailboxLocalPart } from "../local-part.js";
import type { MailboxSession } from "../../domain/models.js";
import type { MailProviderAdapter, ProviderProbeResult } from "../contracts.js";
import {
  MailTmClient,
  decodeMailTmMailboxRef,
  encodeMailTmMailboxRef,
  probeMailTmInstance,
} from "./client.js";

function createLocalPart(hostId: string, sessionId: string): string {
  return createMailboxLocalPart(hostId, sessionId);
}

export { probeMailTmInstance } from "./client.js";

export class MailTmProviderAdapter implements MailProviderAdapter {
  public readonly typeKey = "mailtm" as const;

  public async createMailboxSession(
    { request, instance, now }: Parameters<MailProviderAdapter["createMailboxSession"]>[0],
  ): Promise<MailboxSession> {
    const sessionId = createId("mailbox", now);
    const client = MailTmClient.fromInstance(instance);
    const suggestedLocalPart = createLocalPart(request.hostId, sessionId);
    const mailbox = suggestedLocalPart
      ? await client.createMailbox({ suggestedLocalPart })
      : await client.createMailbox();

    return {
      id: sessionId,
      hostId: request.hostId,
      providerTypeKey: this.typeKey,
      providerInstanceId: instance.id,
      emailAddress: mailbox.email,
      mailboxRef: encodeMailTmMailboxRef(instance.id, mailbox),
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
    const mailbox = decodeMailTmMailboxRef(session.mailboxRef, instance.id);
    if (!mailbox) {
      return undefined;
    }

    const client = MailTmClient.fromInstance(instance);
    return await client.tryReadLatestCode(
      session.id,
      mailbox,
      instance.id,
      session.metadata.fromContains,
    );
  }

  public async recoverMailboxSession(
    { emailAddress, hostId, instance, now, recoveryFields }: Parameters<NonNullable<MailProviderAdapter["recoverMailboxSession"]>>[0],
  ) {
    const normalizedEmail = emailAddress.trim().toLowerCase();
    const password = recoveryFields?.password?.trim();
    if (!normalizedEmail || !password) {
      return undefined;
    }

    const client = MailTmClient.fromInstance(instance);
    const token = await client.getToken(normalizedEmail, password);
    const mailbox = {
      email: normalizedEmail,
      token,
      password,
    };

    return {
      strategy: "account_restore" as const,
      session: {
        id: createId("mailbox", now),
        hostId: hostId?.trim() || `recovery:${this.typeKey}`,
        providerTypeKey: this.typeKey,
        providerInstanceId: instance.id,
        emailAddress: mailbox.email,
        mailboxRef: encodeMailTmMailboxRef(instance.id, mailbox),
        status: "open" as const,
        createdAt: now.toISOString(),
        metadata: {
          recoveredFromEmailAddress: mailbox.email,
          recoveryStrategy: "account_restore",
          recoverySource: "provider_password_relogin",
        },
      },
      detail: "password_relogin",
    };
  }

  public async probeInstance(
    { instance }: Parameters<MailProviderAdapter["probeInstance"]>[0],
  ): Promise<ProviderProbeResult> {
    return await probeMailTmInstance(instance);
  }
}

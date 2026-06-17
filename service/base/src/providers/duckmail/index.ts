import { createId } from "../../shared/index.js";
import type { MailboxSession } from "../../domain/models.js";
import type { MailProviderAdapter, ProviderProbeResult } from "../contracts.js";
import {
  DuckMailClient,
  decodeDuckMailMailboxRef,
  encodeDuckMailMailboxRef,
  probeDuckMailInstance,
} from "./client.js";
import { createMailboxLocalPart } from "../local-part.js";

function createLocalPart(hostId: string, sessionId: string): string {
  return createMailboxLocalPart(hostId, sessionId);
}

export { probeDuckMailInstance } from "./client.js";

export class DuckMailProviderAdapter implements MailProviderAdapter {
  public readonly typeKey = "duckmail" as const;

  public async createMailboxSession(
    { request, instance, now }: Parameters<MailProviderAdapter["createMailboxSession"]>[0],
  ): Promise<MailboxSession> {
    const sessionId = createId("mailbox", now);
    const client = DuckMailClient.fromInstance(instance);
    const mailbox = await client.createMailbox({
      suggestedLocalPart: createLocalPart(request.hostId, sessionId),
    });

    return {
      id: sessionId,
      hostId: request.hostId,
      providerTypeKey: this.typeKey,
      providerInstanceId: instance.id,
      emailAddress: mailbox.email,
      mailboxRef: encodeDuckMailMailboxRef(instance.id, mailbox),
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
    const mailbox = decodeDuckMailMailboxRef(session.mailboxRef, instance.id);
    if (!mailbox) {
      return undefined;
    }

    const client = DuckMailClient.fromInstance(instance);
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

    const client = DuckMailClient.fromInstance(instance);
    const token = await client.getToken(normalizedEmail, password);
    const mailbox = {
      email: normalizedEmail,
      token,
      password,
      accountId: recoveryFields?.accountId?.trim() || "unknown",
    };

    return {
      strategy: "account_restore" as const,
      session: {
        id: createId("mailbox", now),
        hostId: hostId?.trim() || `recovery:${this.typeKey}`,
        providerTypeKey: this.typeKey,
        providerInstanceId: instance.id,
        emailAddress: mailbox.email,
        mailboxRef: encodeDuckMailMailboxRef(instance.id, mailbox),
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
    return await probeDuckMailInstance(instance);
  }
}

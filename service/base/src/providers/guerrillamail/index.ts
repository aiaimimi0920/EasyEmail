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

function splitEmailAddress(emailAddress: string): { emailUser: string; domain: string } | undefined {
  const normalized = emailAddress.trim().toLowerCase();
  const parts = normalized.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return undefined;
  }
  return {
    emailUser: parts[0],
    domain: parts[1],
  };
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

  public async recoverMailboxSession(
    { emailAddress, hostId, instance, now, recoveryFields }: Parameters<NonNullable<MailProviderAdapter["recoverMailboxSession"]>>[0],
  ) {
    const identity = splitEmailAddress(emailAddress);
    const emailUser = recoveryFields?.emailUser?.trim().toLowerCase() || identity?.emailUser;
    const domain = identity?.domain;
    if (!identity || !emailUser || !domain) {
      return undefined;
    }

    const domainScopedInstance: ProviderInstance = {
      ...instance,
      metadata: {
        ...instance.metadata,
        domain: instance.metadata.domain?.trim() || domain,
      },
    };
    const client = GuerrillaMailClient.fromInstance(domainScopedInstance);
    const seeded = await client.getEmailAddress();
    const sidToken = typeof seeded.sid_token === "string" ? seeded.sid_token : undefined;
    const recovered = await client.setEmailUser(emailUser, sidToken);
    const recoveredAddress = typeof recovered.email_addr === "string" ? recovered.email_addr.trim().toLowerCase() : "";
    const recoveredSidToken = typeof recovered.sid_token === "string"
      ? recovered.sid_token.trim()
      : sidToken?.trim() || "";
    const recoveredEmailUser = typeof recovered.email_user === "string"
      ? recovered.email_user.trim().toLowerCase()
      : emailUser;

    if (!recoveredAddress || recoveredAddress !== identity.emailUser + "@" + domain || !recoveredSidToken) {
      return undefined;
    }

    const mailbox = {
      emailAddress: recoveredAddress,
      emailUser: recoveredEmailUser,
      sidToken: recoveredSidToken,
    };

    return {
      strategy: "recreate_same_address" as const,
      session: {
        id: createId("mailbox", now),
        hostId: hostId?.trim() || `recovery:${this.typeKey}`,
        providerTypeKey: this.typeKey,
        providerInstanceId: instance.id,
        emailAddress: mailbox.emailAddress,
        mailboxRef: encodeGuerrillaMailMailboxRef(instance.id, mailbox),
        status: "open" as const,
        createdAt: now.toISOString(),
        metadata: {
          recoveredFromEmailAddress: mailbox.emailAddress,
          recoveryStrategy: "recreate_same_address",
          recoverySource: "provider_same_user_recreation",
        },
      },
      detail: "same_user_recreation",
    };
  }

  public async probeInstance(
    { instance }: Parameters<MailProviderAdapter["probeInstance"]>[0],
  ): Promise<ProviderProbeResult> {
    return await probeGuerrillaMailInstance(instance);
  }
}

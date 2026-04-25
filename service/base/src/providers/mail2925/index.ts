import { createId } from "../../shared/index.js";
import { EasyEmailError } from "../../domain/errors.js";
import type { MailboxSession, ProviderInstance } from "../../domain/models.js";
import type { MailProviderAdapter, ProviderProbeResult } from "../contracts.js";
import { createMailboxLocalPart } from "../local-part.js";
import {
  Mail2925Client,
  decodeMail2925MailboxRef,
  encodeMail2925MailboxRef,
  probeMail2925Instance,
} from "./client.js";

function createSessionHint(hostId: string, sessionId: string): string {
  return createMailboxLocalPart(hostId, sessionId);
}

function resolveRequestedDomain(requestMetadata: Record<string, string> | undefined, requestedDomain: string | undefined): string | undefined {
  const explicit = requestedDomain?.trim() || requestMetadata?.requestedDomain?.trim() || requestMetadata?.domain?.trim();
  return explicit || undefined;
}

export { probeMail2925Instance } from "./client.js";

export class Mail2925ProviderAdapter implements MailProviderAdapter {
  public readonly typeKey = "mail2925" as ProviderInstance["providerTypeKey"];

  public async createMailboxSession(
    { request, instance, credentialSets, now }: Parameters<MailProviderAdapter["createMailboxSession"]>[0],
  ): Promise<MailboxSession> {
    const sessionId = createId("mailbox", now);
    const client = Mail2925Client.fromInstance(instance, credentialSets)
      ?? Mail2925Client.fromInstance(instance);
    if (!client) {
      throw new EasyEmailError(
        "MAIL2925_CONFIGURATION_MISSING",
        `2925 instance ${instance.id} is missing credentialSets/account/password/accountsFile configuration.`,
      );
    }

    const mailbox = await client.createMailbox({
      sessionHint: createSessionHint(request.hostId, sessionId),
      requestedDomain: resolveRequestedDomain(request.metadata, request.requestedDomain),
      createdAt: now.toISOString(),
    });

    return {
      id: sessionId,
      hostId: request.hostId,
      providerTypeKey: this.typeKey,
      providerInstanceId: instance.id,
      emailAddress: mailbox.aliasAddress,
      mailboxRef: encodeMail2925MailboxRef(instance.id, mailbox),
      status: "open",
      createdAt: now.toISOString(),
      expiresAt: request.ttlMinutes
        ? new Date(now.getTime() + request.ttlMinutes * 60 * 1000).toISOString()
        : undefined,
      metadata: {
        ...(request.metadata ?? {}),
        accountEmail: mailbox.accountEmail,
      },
    };
  }

  public async syncMailboxCode(
    { session, instance, credentialSets }: Parameters<NonNullable<MailProviderAdapter["syncMailboxCode"]>>[0],
  ) {
    const mailbox = decodeMail2925MailboxRef(session.mailboxRef, instance.id);
    if (!mailbox) {
      return undefined;
    }

    const client = Mail2925Client.fromInstance(instance, credentialSets)
      ?? Mail2925Client.fromInstance(instance);
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

  public async probeInstance(
    { instance, credentialSets }: Parameters<MailProviderAdapter["probeInstance"]>[0],
  ): Promise<ProviderProbeResult> {
    return await probeMail2925Instance(instance, credentialSets.length > 0 ? credentialSets : undefined);
  }
}

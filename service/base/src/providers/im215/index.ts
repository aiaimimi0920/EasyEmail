import { createId } from "../../shared/index.js";
import { EasyEmailError } from "../../domain/errors.js";
import { createMailboxLocalPart } from "../local-part.js";
import type { MailboxSession, ProviderInstance } from "../../domain/models.js";
import type { MailProviderAdapter, ProviderProbeResult, RecoverMailboxSessionInput, RecoverMailboxSessionResult } from "../contracts.js";
import {
  Im215Client,
  decodeIm215MailboxRef,
  encodeIm215MailboxRef,
  probeIm215Instance,
} from "./client.js";

const IM215_TYPE_KEY = "im215" as unknown as ProviderInstance["providerTypeKey"];

function createLocalPart(hostId: string, sessionId: string): string {
  return createMailboxLocalPart(hostId, sessionId);
}

function resolveMailboxDomain(instance: ProviderInstance, requestMetadata: Record<string, string> | undefined): string | undefined {
  const requestDomain = requestMetadata?.requestedDomain?.trim() || requestMetadata?.domain?.trim();
  if (requestDomain) {
    return requestDomain;
  }
  const instanceDomain = instance.metadata.domain;
  return instanceDomain && instanceDomain.trim() ? instanceDomain.trim() : undefined;
}

export { probeIm215Instance } from "./client.js";

export class Im215ProviderAdapter implements MailProviderAdapter {
  public readonly typeKey = IM215_TYPE_KEY;

  public async createMailboxSession(
    { request, instance, credentialSets, now }: Parameters<MailProviderAdapter["createMailboxSession"]>[0],
  ): Promise<MailboxSession> {
    const sessionId = createId("mailbox", now);
    const client = Im215Client.fromInstance(instance, credentialSets);
    if (!client) {
      throw new EasyEmailError(
        "IM215_CONFIGURATION_MISSING",
        `215.im instance ${instance.id} is missing credentialSets/apiKey/keysFile configuration.`,
      );
    }
    const mailbox = await client.createMailbox({
      suggestedLocalPart: createLocalPart(request.hostId, sessionId),
      preferredDomain: resolveMailboxDomain(instance, request.metadata),
    });

    return {
      id: sessionId,
      hostId: request.hostId,
      providerTypeKey: this.typeKey,
      providerInstanceId: instance.id,
      emailAddress: mailbox.address,
      mailboxRef: encodeIm215MailboxRef(instance.id, mailbox),
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
    const mailbox = decodeIm215MailboxRef(session.mailboxRef, instance.id);
    if (!mailbox) {
      return undefined;
    }

    const client = Im215Client.fromInstance(instance, credentialSets);
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
    { emailAddress, hostId, instance, credentialSets, now }: RecoverMailboxSessionInput,
  ): Promise<RecoverMailboxSessionResult | undefined> {
    const client = Im215Client.fromInstance(instance, credentialSets);
    if (!client) {
      throw new EasyEmailError(
        "IM215_CONFIGURATION_MISSING",
        `215.im instance ${instance.id} is missing credentialSets/apiKey/keysFile configuration.`,
      );
    }

    const mailbox = await client.recreateMailboxByEmailAddress(emailAddress);
    const session: MailboxSession = {
      id: createId("mailbox", now),
      hostId: hostId?.trim() || `recovery:${this.typeKey}`,
      providerTypeKey: this.typeKey,
      providerInstanceId: instance.id,
      emailAddress: mailbox.address,
      mailboxRef: encodeIm215MailboxRef(instance.id, mailbox),
      status: "open",
      createdAt: now.toISOString(),
      metadata: {
        recoveredFromEmailAddress: mailbox.address,
        recoveryStrategy: "recreate_same_address",
        recoverySource: "same_address_recreation",
      },
    };

    return {
      strategy: "recreate_same_address",
      detail: "215.im same-address mailbox recreation completed.",
      session,
    };
  }

  public async probeInstance(
    { instance, credentialSets }: Parameters<MailProviderAdapter["probeInstance"]>[0],
  ): Promise<ProviderProbeResult> {
    return await probeIm215Instance(instance, credentialSets.length > 0 ? credentialSets : undefined);
  }
}

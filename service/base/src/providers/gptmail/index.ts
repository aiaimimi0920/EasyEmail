import { createId } from "../../shared/index.js";
import { EasyEmailError } from "../../domain/errors.js";
import type { MailboxSession } from "../../domain/models.js";
import type { MailProviderAdapter, ProviderProbeResult } from "../contracts.js";
import { GptMailClient, probeGptMailInstance } from "./client.js";

export interface GptMailProviderAdapterOptions {
  strictMode?: boolean;
}

export { probeGptMailInstance } from "./client.js";

export class GptMailProviderAdapter implements MailProviderAdapter {
  public readonly typeKey = "gptmail" as const;

  public constructor(private readonly _options: GptMailProviderAdapterOptions = {}) {}

  public async createMailboxSession(
    { request, instance, credentialSets, now }: Parameters<MailProviderAdapter["createMailboxSession"]>[0],
  ): Promise<MailboxSession> {
    const client = GptMailClient.fromInstance(instance, credentialSets);

    if (!client) {
      throw new EasyEmailError(
        "GPTMAIL_CONFIGURATION_MISSING",
        `GPTMail instance ${instance.id} is missing usable credentialSets/apiKey/keysFile configuration.`,
      );
    }

    const sessionId = createId("mailbox", now);
    const emailAddress = await client.generateEmail(request.hostId);
    return {
      id: sessionId,
      hostId: request.hostId,
      providerTypeKey: this.typeKey,
      providerInstanceId: instance.id,
      emailAddress,
      mailboxRef: `gptmail:${instance.id}:${encodeURIComponent(emailAddress)}`,
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
    const client = GptMailClient.fromInstance(instance, credentialSets);
    if (!client) {
      return undefined;
    }

    const fromContains = session.metadata.fromContains;
    return await client.tryReadLatestCode(
      session.id,
      session.emailAddress,
      instance.id,
      fromContains,
    );
  }

  public async probeInstance(
    { instance, credentialSets }: Parameters<MailProviderAdapter["probeInstance"]>[0],
  ): Promise<ProviderProbeResult> {
    return await probeGptMailInstance(instance, credentialSets.length > 0 ? credentialSets : undefined);
  }
}

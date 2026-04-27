import { createId } from "../../../shared/index.js";
import { createMailboxLocalPart } from "../../local-part.js";
import { EasyEmailError } from "../../../domain/errors.js";
import type { ProviderInstance } from "../../../domain/models.js";
import type { MailboxSession } from "../../../domain/models.js";
import type { MailProviderAdapter, ProviderProbeResult } from "../../contracts.js";
import {
  CloudflareTempEmailCreateClient,
  type CloudflareTempEmailSendResult,
  decodeCloudflareTempMailboxRef,
  encodeCloudflareTempMailboxRef,
  probeCloudflareTempEmailInstance,
} from "./client.js";

export interface CloudflareTempEmailConnectorAdapterOptions {
  strictMode?: boolean;
}

function createLocalPart(hostId: string, sessionId: string): string {
  return createMailboxLocalPart(hostId, sessionId);
}

function isStrictMode(instance: ProviderInstance, fallback: boolean): boolean {
  const raw = instance.metadata.strictMode;
  if (!raw) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export { probeCloudflareTempEmailInstance } from "./client.js";

export class CloudflareTempEmailConnectorAdapter implements MailProviderAdapter {
  public readonly typeKey = "cloudflare_temp_email" as const;

  public constructor(private readonly options: CloudflareTempEmailConnectorAdapterOptions = {}) {}

  public async createMailboxSession(
    { request, instance, now }: Parameters<MailProviderAdapter["createMailboxSession"]>[0],
  ): Promise<MailboxSession> {
    const sessionId = createId("mailbox", now);
    const localPart = createLocalPart(request.hostId, sessionId);
    const requestedDomain = request.requestedDomain?.trim()
      || request.metadata?.requestedDomain?.trim()
      || request.metadata?.mailcreateDomain?.trim()
      || undefined;
    const client = CloudflareTempEmailCreateClient.fromInstance(instance);
    const requestRandomSubdomain = request.requestRandomSubdomain === true;

    if (client) {
      const mailbox = await client.newAddress(localPart, {
        requestedDomain,
        requestRandomSubdomain,
      });
      return {
        id: sessionId,
        hostId: request.hostId,
        providerTypeKey: this.typeKey,
        providerInstanceId: instance.id,
        emailAddress: mailbox.address,
        mailboxRef: encodeCloudflareTempMailboxRef(instance.id, mailbox),
        status: "open",
        createdAt: now.toISOString(),
        expiresAt: request.ttlMinutes
          ? new Date(now.getTime() + request.ttlMinutes * 60 * 1000).toISOString()
          : undefined,
        metadata: { ...(request.metadata ?? {}) },
      };
    }

    if (isStrictMode(instance, this.options.strictMode ?? false)) {
      throw new EasyEmailError(
        "CLOUDFLARE_TEMP_EMAIL_ENDPOINT_MISSING",
        `Cloudflare Temp Email instance ${instance.id} is missing baseUrl/connectionRef and cannot open a real mailbox.`,
      );
    }

    const domain = requestedDomain || instance.metadata.domain || "cloudflare-temp-email.local";
    return {
      id: sessionId,
      hostId: request.hostId,
      providerTypeKey: this.typeKey,
      providerInstanceId: instance.id,
      emailAddress: `${localPart}@${domain}`,
      mailboxRef: `cloudflare_temp_email:${instance.id}:${sessionId}`,
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
    const mailbox = decodeCloudflareTempMailboxRef(session.mailboxRef, instance.id);
    if (!mailbox) {
      return undefined;
    }

    const client = CloudflareTempEmailCreateClient.fromInstance(instance);
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

  public async sendMailboxMessage(
    { session, instance, request, now }: Parameters<NonNullable<MailProviderAdapter["sendMailboxMessage"]>>[0],
  ) {
    const mailbox = decodeCloudflareTempMailboxRef(session.mailboxRef, instance.id);
    if (!mailbox) {
      throw new EasyEmailError(
        "MAILBOX_SEND_NOT_SUPPORTED",
        `Cloudflare Temp Email session ${session.id} is missing mailbox credentials.`,
      );
    }

    const client = CloudflareTempEmailCreateClient.fromInstance(instance);
    if (!client) {
      throw new EasyEmailError(
        "MAILBOX_SEND_NOT_SUPPORTED",
        `Cloudflare Temp Email instance ${instance.id} is missing baseUrl/connectionRef and cannot send mail.`,
      );
    }

    const sendResult: CloudflareTempEmailSendResult = await client.sendMailboxMessage(mailbox, request);
    return {
      sessionId: session.id,
      providerTypeKey: this.typeKey,
      providerInstanceId: instance.id,
      senderEmailAddress: session.emailAddress,
      recipientEmailAddress: request.toEmailAddress,
      sentAt: now.toISOString(),
      deliveryMode: sendResult.deliveryMode,
      detail: sendResult.detail,
    };
  }

  public async probeInstance(
    { instance }: Parameters<MailProviderAdapter["probeInstance"]>[0],
  ): Promise<ProviderProbeResult> {
    const result = await probeCloudflareTempEmailInstance(instance);
    const metadata: Record<string, string> = {
      ...(result.metadata ?? {}),
    };
    const domain = typeof result.settings?.address === "string"
      ? result.settings.address
      : (typeof result.settings?.defaultDomain === "string" ? result.settings.defaultDomain : undefined);
    if (domain) {
      metadata.domain = domain;
    }

    return {
      ok: result.ok,
      detail: result.detail,
      averageLatencyMs: result.averageLatencyMs,
      metadata,
    };
  }
}

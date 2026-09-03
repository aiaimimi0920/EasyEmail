import type { CredentialSelection, CredentialSetDefinition } from "../../shared/index.js";
import type { ObservedMessage, ProviderInstance } from "../../domain/models.js";
import { resolveMoemailConfig, resolveMoemailCredentialSets } from "./configuration.js";
import { MoemailCredentialExecutor } from "./credential-executor.js";
import {
  buildStatusError,
  classifyMoemailError,
  isMailboxAlreadyUsedError,
} from "./failure.js";
import { requestJson } from "./http.js";
import { MoemailMailboxApi } from "./mailbox-api.js";
import {
  asRecord,
  createLocalPartSeed,
  deriveTextBodyFromHtml,
  extractDomainsFromConfig,
  extractOtp,
  matchesSenderFilter,
  nextConfigDomainRotationOffset,
  normalizeEmailAddress,
  readMessageHtml,
  readMessageSender,
  readMessageSubject,
  readMessageText,
  splitEmailAddress,
  toIsoTimestamp,
} from "./payload.js";
import type {
  MoemailConfig,
  MoemailMailboxCredentials,
  MoemailMailboxListingEntry,
  MoemailMessageSummary,
} from "./types.js";
import { deleteMailboxViaWebSession } from "./web-session.js";

export { resolveMoemailConfig, resolveMoemailCredentialSets } from "./configuration.js";
export { classifyMoemailFailure } from "./failure.js";
export { decodeMoemailMailboxRef, encodeMoemailMailboxRef } from "./mailbox-ref.js";
export type {
  ClassifiedMoemailFailure,
  MoemailConfig,
  MoemailMailboxCredentials,
  MoemailMailboxListingEntry,
} from "./types.js";

export class MoemailClient {
  private readonly credentials: MoemailCredentialExecutor;
  private readonly mailboxApi: MoemailMailboxApi;

  public constructor(private readonly config: MoemailConfig) {
    this.credentials = new MoemailCredentialExecutor(config);
    this.mailboxApi = new MoemailMailboxApi(config);
  }

  private async recoverRequestedMailboxConflict(
    selection: CredentialSelection,
    apiKey: string,
    error: unknown,
    options: {
      requestedEmail?: string;
      localPart: string;
      expiryTime?: number;
      domain?: string;
    },
  ): Promise<MoemailMailboxCredentials | undefined> {
    const requestedEmail = normalizeEmailAddress(options.requestedEmail);
    if (!requestedEmail || !isMailboxAlreadyUsedError(error)) {
      return undefined;
    }

    const existing = await this.mailboxApi.findMailboxByEmailAddress(apiKey, requestedEmail);
    if (!existing) {
      return undefined;
    }

    const mailboxAccess = await this.mailboxApi.inspectMailboxAccess(apiKey, existing);
    if (mailboxAccess.status === "accessible") {
      return this.credentials.bindMailbox(existing, selection);
    }

    if (mailboxAccess.status !== "missing") {
      return undefined;
    }

    await this.deleteMailbox(existing.emailId, "generate");

    for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
      if (attemptIndex > 0) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attemptIndex));
      }
      try {
        const mailbox = await this.mailboxApi.generateMailbox(apiKey, {
          localPart: options.localPart,
          expiryTime: options.expiryTime,
          domain: options.domain,
        });
        return this.credentials.bindMailbox(mailbox, selection);
      } catch (retryError) {
        if (!isMailboxAlreadyUsedError(retryError) || attemptIndex >= 2) {
          throw retryError;
        }
      }
    }

    return undefined;
  }

  public async recoverMailboxByEmailAddress(
    emailAddress: string,
  ): Promise<{ mailbox: MoemailMailboxCredentials; strategy: "account_restore" | "recreate_same_address" } | undefined> {
    const requestedEmail = normalizeEmailAddress(emailAddress);
    if (!requestedEmail) {
      return undefined;
    }

    return this.credentials.run("generate", requestedEmail, async (selection, apiKey) => {
      const requestedIdentity = splitEmailAddress(requestedEmail);
      if (!requestedIdentity) {
        return undefined;
      }

      const existing = await this.mailboxApi.findMailboxByEmailAddress(apiKey, requestedEmail);
      if (existing) {
        const mailboxAccess = await this.mailboxApi.inspectMailboxAccess(apiKey, existing);
        if (mailboxAccess.status === "accessible") {
          return {
            mailbox: this.credentials.bindMailbox(existing, selection),
            strategy: "account_restore" as const,
          };
        }
        if (mailboxAccess.status !== "missing") {
          return undefined;
        }
        await this.mailboxApi.deleteMailbox(apiKey, existing.emailId, "generate");
      }

      try {
        const mailbox = await this.mailboxApi.generateMailbox(apiKey, {
          localPart: requestedIdentity.localPart,
          expiryTime: this.config.expiryTimeMs,
          domain: requestedIdentity.domain,
        });
        return {
          mailbox: this.credentials.bindMailbox(mailbox, selection),
          strategy: "recreate_same_address" as const,
        };
      } catch (error) {
        const recovered = await this.recoverRequestedMailboxConflict(selection, apiKey, error, {
          requestedEmail,
          localPart: requestedIdentity.localPart,
          expiryTime: this.config.expiryTimeMs,
          domain: requestedIdentity.domain,
        });
        if (!recovered) {
          return undefined;
        }
        return {
          mailbox: recovered,
          strategy: "recreate_same_address" as const,
        };
      }
    });
  }

  public static fromInstance(
    instance: ProviderInstance,
    credentialSets?: CredentialSetDefinition[],
    options: {
      namespace?: string;
    } = {},
  ): MoemailClient | undefined {
    const config = resolveMoemailConfig(instance, credentialSets, options);
    if (config.credentialSets.length === 0) {
      return undefined;
    }

    return new MoemailClient(config);
  }

  public async getConfig(): Promise<Record<string, unknown>> {
    return this.credentials.run("poll", "probe", async (_selection, apiKey) => {
      const response = await requestJson(this.config, apiKey, "GET", "/api/config");
      if (response.status !== 200) {
        throw buildStatusError("getConfig", response.status, response.body);
      }
      return asRecord(response.body);
    });
  }

  public async createMailbox(options: {
    name?: string;
    expiryTime?: number;
    domain?: string;
  } = {}): Promise<MoemailMailboxCredentials> {
    return this.credentials.run("generate", options.name, async (selection, apiKey) => {
      const requestedIdentity = splitEmailAddress(options.name);
      const localPart = requestedIdentity?.localPart || createLocalPartSeed(options.name);
      let domain = requestedIdentity?.domain || options.domain?.trim() || this.config.preferredDomain;
      if (!domain) {
        const configResponse = await requestJson(this.config, apiKey, "GET", "/api/config");
        if (configResponse.status === 200) {
          const configDomains = extractDomainsFromConfig(asRecord(configResponse.body));
          if (configDomains.length > 0) {
            const rotationOffset = nextConfigDomainRotationOffset(
              `${this.config.instanceId}:${this.config.apiBase.trim().toLowerCase()}`,
              configDomains,
            );
            domain = configDomains[rotationOffset];
          }
        }
      }
      try {
        const mailbox = await this.mailboxApi.generateMailbox(apiKey, {
          localPart,
          expiryTime: options.expiryTime,
          domain,
        });
        return this.credentials.bindMailbox(mailbox, selection);
      } catch (error) {
        const recovered = await this.recoverRequestedMailboxConflict(selection, apiKey, error, {
          requestedEmail: requestedIdentity?.email,
          localPart,
          expiryTime: options.expiryTime,
          domain,
        });
        if (recovered) {
          return recovered;
        }
        throw error;
      }
    });
  }

  public async listEmails(
    cursor?: string,
    useCase: "generate" | "poll" = "poll",
  ): Promise<{ emails: MoemailMailboxListingEntry[]; nextCursor?: string; total?: number }> {
    return this.credentials.run(
      useCase,
      cursor ? `list:${cursor}` : "list",
      async (_selection, apiKey) => this.mailboxApi.listEmails(apiKey, cursor),
    );
  }

  public async listMailboxMessages(
    mailbox: MoemailMailboxCredentials,
    cursor: string | undefined,
  ): Promise<{ items: MoemailMessageSummary[]; nextCursor?: string }> {
    return this.credentials.run(
      "poll",
      mailbox.emailId,
      async (_selection, apiKey) => this.mailboxApi.listMailboxMessages(apiKey, mailbox.emailId, cursor),
      { preferredSelection: this.credentials.resolveBound(mailbox, "poll") },
    );
  }

  public async getMailboxMessage(
    mailbox: MoemailMailboxCredentials,
    messageId: string,
  ): Promise<Record<string, unknown>> {
    return this.credentials.run(
      "poll",
      `${mailbox.emailId}:${messageId}`,
      async (_selection, apiKey) => this.mailboxApi.getMailboxMessage(apiKey, mailbox, messageId),
      { preferredSelection: this.credentials.resolveBound(mailbox, "poll") },
    );
  }

  public async deleteMailbox(
    mailboxOrEmailId: string | MoemailMailboxCredentials,
    useCase: "generate" | "poll" = "poll",
    options: { fallbackToApiKeyAfterWebUnauthorized?: boolean } = {},
  ): Promise<{ released: boolean; detail: string }> {
    const mailbox = typeof mailboxOrEmailId === "string" ? undefined : mailboxOrEmailId;
    const emailId = typeof mailboxOrEmailId === "string" ? mailboxOrEmailId : mailboxOrEmailId.emailId;
    const preferredSelection = mailbox ? this.credentials.resolveBound(mailbox, useCase) : undefined;

    if (this.config.webSessionToken?.trim()) {
      const webResult = await deleteMailboxViaWebSession(this.config, emailId);
      if (
        webResult.released
        || webResult.detail !== "upstream_delete_unauthorized"
        || !options.fallbackToApiKeyAfterWebUnauthorized
      ) {
        return webResult;
      }

      const apiKeyResult = await this.credentials.run(
        useCase,
        emailId,
        async (_selection, apiKey) => this.mailboxApi.deleteMailbox(apiKey, emailId, useCase),
        { preferredSelection },
      );
      if (apiKeyResult.released && apiKeyResult.detail === "deleted") {
        return {
          released: true,
          detail: "deleted_api_key_after_web_unauthorized",
        };
      }
      return {
        released: apiKeyResult.released,
        detail: `api_key_after_web_unauthorized:${apiKeyResult.detail}`,
      };
    }

    return this.credentials.run(
      useCase,
      emailId,
      async (_selection, apiKey) => this.mailboxApi.deleteMailbox(apiKey, emailId, useCase),
      { preferredSelection },
    );
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: MoemailMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    let cursor: string | undefined;

    for (let page = 0; page < 3; page += 1) {
      const batch = await this.listMailboxMessages(mailbox, cursor);
      for (const item of batch.items) {
        if (!matchesSenderFilter(item.sender, fromContains)) {
          continue;
        }

        const summaryOtp = extractOtp({
          subject: item.subject,
          textBody: item.textBody,
          htmlBody: item.htmlBody,
        });
        if (summaryOtp) {
          return {
            id: `moemail:${item.messageId}`,
            sessionId,
            providerInstanceId,
            observedAt: item.observedAt,
            sender: item.sender,
            subject: item.subject,
            textBody: item.textBody,
            htmlBody: item.htmlBody,
            extractedCode: summaryOtp.code,
            codeSource: summaryOtp.source,
          };
        }

        const detail = await this.getMailboxMessage(mailbox, item.messageId);
        const sender = readMessageSender(detail) ?? item.sender;
        if (!matchesSenderFilter(sender, fromContains)) {
          continue;
        }
        const subject = readMessageSubject(detail) ?? item.subject;
        const htmlBody = readMessageHtml(detail) ?? item.htmlBody;
        const textBody = readMessageText(detail) ?? item.textBody ?? deriveTextBodyFromHtml(htmlBody);
        const detailOtp = extractOtp({
          subject,
          textBody,
          htmlBody,
        });
        return {
          id: `moemail:${item.messageId}`,
          sessionId,
          providerInstanceId,
          observedAt: toIsoTimestamp(
            detail.received_at
            ?? detail.receivedAt
            ?? detail.sent_at
            ?? detail.createdAt
            ?? detail.created_at
            ?? detail.updatedAt
            ?? detail.updated_at
            ?? item.observedAt,
          ),
          sender,
          subject,
          textBody,
          htmlBody,
          extractedCode: detailOtp?.code,
          ...(detailOtp?.candidates ? { extractedCandidates: detailOtp.candidates } : {}),
          codeSource: detailOtp?.source,
        };
      }

      if (!batch.nextCursor?.trim()) {
        break;
      }
      cursor = batch.nextCursor;
    }

    return undefined;
  }
}

export async function probeMoemailInstance(
  instance: ProviderInstance,
  credentialSets?: CredentialSetDefinition[],
): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const client = MoemailClient.fromInstance(instance, credentialSets);
  if (!client) {
    return {
      ok: false,
      detail: "MoEmail instance is missing credentialSets/apiKey/keysFile configuration.",
      averageLatencyMs: instance.averageLatencyMs,
    };
  }

  const startedAt = Date.now();
  try {
    const config = await client.getConfig();
    const domains = extractDomainsFromConfig(config);

    return {
      ok: true,
      detail: domains.length > 0
        ? `MOEMAIL_PROBE_OK: MoEmail returned ${domains.length} domains.`
        : "MOEMAIL_PROBE_OK: MoEmail config endpoint responded.",
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "moemail",
        ...(domains.length > 0 ? { domainsCsv: domains.join(",") } : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "moemail",
        errorClass: classifyMoemailError(error instanceof Error ? error.message : String(error)),
      },
    };
  }
}

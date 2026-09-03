import {
  markCredentialCriticalFailure,
  markCredentialFailure,
  markCredentialSuccess,
  selectCredentialItem,
  type CredentialSelection,
  type CredentialSetDefinition,
} from "../../shared/index.js";
import type { ObservedMessage, ProviderInstance } from "../../domain/models.js";
import {
  Im215ClientError,
  asRecord,
  buildIm215StatusError,
  classifyIm215Error,
  classifyThrownError,
  createRandomSuffix,
  extractDomainCandidates,
  extractMailboxPayload,
  extractMessageList,
  extractOtp,
  isSharedDomainRestrictionMessage,
  matchesSenderFilter,
  nextDomainRotationOffset,
  normalizeDomain,
  parseExactEmailAddress,
  readMessageHtml,
  readMessageId,
  readMessageSender,
  readMessageSubject,
  readMessageText,
  readObservedAt,
  readString,
  requestJson,
  resolveIm215Config,
  sanitizeLocalPart,
  type Im215Config,
  type Im215MailboxRefPayload,
} from "./protocol.js";

export { resolveIm215Config, resolveIm215CredentialSets } from "./protocol.js";
export type { Im215Config, Im215MailboxRefPayload } from "./protocol.js";
export class Im215Client {
  public constructor(private readonly config: Im215Config) {}

  public static fromInstance(
    instance: ProviderInstance,
    credentialSets?: CredentialSetDefinition[],
  ): Im215Client | undefined {
    const config = resolveIm215Config(instance, credentialSets);
    if (config.credentialSets.length === 0) {
      return undefined;
    }

    return new Im215Client(config);
  }

  private countCandidateItems(useCase: "generate" | "poll"): number {
    return this.config.credentialSets
      .filter((set) => set.useCases.includes(useCase))
      .reduce((sum, set) => sum + set.items.length, 0);
  }

  private select(useCase: "generate" | "poll", stickyKey?: string): CredentialSelection | undefined {
    return selectCredentialItem({
      namespace: this.config.namespace,
      sets: this.config.credentialSets,
      useCase,
      stickyKey,
    });
  }

  private handleCredentialFailure(selection: CredentialSelection, error: unknown): Im215ClientError {
    return this.handleCredentialFailureWithOptions(selection, error, {});
  }

  private handleCredentialFailureWithOptions(
    selection: CredentialSelection,
    error: unknown,
    options: {
      suppressTransientCooldown?: boolean;
    },
  ): Im215ClientError {
    const classified = classifyThrownError(error);
    if (classified.kind === "auth") {
      markCredentialCriticalFailure(this.config.namespace, selection.set, selection.item, {
        status: "cooling",
        error: classified.message,
      });
      return classified;
    }
    if (classified.kind === "capacity") {
      markCredentialCriticalFailure(this.config.namespace, selection.set, selection.item, {
        status: "rate-limited",
        error: classified.message,
      });
      return classified;
    }

    if (classified.kind === "provider") {
      markCredentialCriticalFailure(this.config.namespace, selection.set, selection.item, {
        status: "cooling",
        error: classified.message,
      });
      return classified;
    }

    if (!(classified.kind === "transient" && options.suppressTransientCooldown)) {
      markCredentialFailure(this.config.namespace, selection.set, selection.item, {
        status: "cooling",
        cooldownMs: classified.kind === "transient" ? 30_000 : 60_000,
        error: classified.message,
      });
    }
    return classified;
  }

  private async withCredential<T>(
    useCase: "generate" | "poll",
    stickyKey: string | undefined,
    callback: (selection: CredentialSelection, apiKey: string) => Promise<T>,
    options: {
      suppressTransientCooldown?: boolean;
    } = {},
  ): Promise<T> {
    const attempts = Math.max(1, this.countCandidateItems(useCase));
    let lastError: Error | undefined;

    for (let index = 0; index < attempts; index += 1) {
      const selection = this.select(useCase, stickyKey);
      if (!selection) {
        break;
      }

      const apiKey = selection.item.value?.trim();
      if (!apiKey) {
        lastError = this.handleCredentialFailure(
          selection,
          new Im215ClientError("Selected 215.im credential is missing key value.", "auth"),
        );
        continue;
      }

      try {
        const result = await callback(selection, apiKey);
        markCredentialSuccess(this.config.namespace, selection.set, selection.item);
        return result;
      } catch (error) {
        lastError = this.handleCredentialFailureWithOptions(selection, error, options);
      }
    }

    throw lastError ?? new Error(`No available 215.im credentials for ${useCase}.`);
  }

  public async getDomains(): Promise<string[]> {
    return this.withCredential("poll", "probe", async (_selection, apiKey) => {
      const response = await requestJson(this.config, apiKey, "GET", "/domains");
      if (response.status !== 200) {
        throw buildIm215StatusError("getDomains", response.status, response.body);
      }

      const domains = extractDomainCandidates(response.body);
      const preferredDomain = normalizeDomain(this.config.preferredDomain);
      return preferredDomain && domains.includes(preferredDomain)
        ? [preferredDomain, ...domains.filter((item) => item !== preferredDomain)]
        : domains;
    }, {
      suppressTransientCooldown: true,
    });
  }

  public async createMailbox(options: { suggestedLocalPart?: string; preferredDomain?: string; maxRetries?: number } = {}): Promise<Im215MailboxRefPayload> {
    const domains = await this.getDomains();
    if (domains.length === 0) {
      throw new Im215ClientError("215.im returned no available domains.", "provider");
    }

    const maxRetries = options.maxRetries ?? 5;
    const baseLocalPart = sanitizeLocalPart(options.suggestedLocalPart);
    const requestedPreferredDomain = normalizeDomain(options.preferredDomain) ?? normalizeDomain(this.config.preferredDomain);
    const pinnedDomain = requestedPreferredDomain && domains.includes(requestedPreferredDomain)
      ? requestedPreferredDomain
      : undefined;
    const rotationOffset = pinnedDomain ? 0 : nextDomainRotationOffset(this.config.namespace, domains.length);

    return this.withCredential("generate", baseLocalPart, async (_selection, apiKey) => {
      let lastRestrictedDomainError: Im215ClientError | undefined;

      for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        const domain = pinnedDomain ?? domains[(rotationOffset + attempt) % domains.length]!;
        const localPart = `${baseLocalPart}-${createRandomSuffix(4)}`.slice(0, 60);
        const address = `${localPart}@${domain}`;
        const payloads: Record<string, unknown>[] = [
          {
            localPart,
            ...(domain ? { domain } : {}),
            ...(this.config.autoDomainStrategy ? { autoDomainStrategy: this.config.autoDomainStrategy } : {}),
          },
          {
            address,
            ...(this.config.autoDomainStrategy ? { autoDomainStrategy: this.config.autoDomainStrategy } : {}),
          },
        ];

        let retryWithNextDomain = false;
        for (const payload of payloads) {
          const response = await requestJson(this.config, apiKey, "POST", "/accounts", {
            jsonBody: payload,
          });

          if (response.status === 200 || response.status === 201) {
            return extractMailboxPayload(response.body) ?? {
              address,
              domain,
            };
          }

          if ([400, 409, 422].includes(response.status)) {
            continue;
          }

          const error = buildIm215StatusError("createMailbox", response.status, response.body);
          if (response.status === 403 && isSharedDomainRestrictionMessage(error.message)) {
            lastRestrictedDomainError = error;
            retryWithNextDomain = true;
            break;
          }

          throw error;
        }

        if (retryWithNextDomain) {
          continue;
        }
      }

      if (lastRestrictedDomainError) {
        throw lastRestrictedDomainError;
      }

      throw new Im215ClientError("215.im mailbox creation exhausted retries.", "capacity");
    });
  }

  public async recreateMailboxByEmailAddress(emailAddress: string): Promise<Im215MailboxRefPayload> {
    const { address, localPart, domain } = parseExactEmailAddress(emailAddress);

    return this.withCredential("generate", address, async (_selection, apiKey) => {
      const payload = {
        localPart,
        domain,
        ...(this.config.autoDomainStrategy ? { autoDomainStrategy: this.config.autoDomainStrategy } : {}),
      };
      const response = await requestJson(this.config, apiKey, "POST", "/accounts", {
        jsonBody: payload,
      });

      if (response.status === 200 || response.status === 201) {
        const mailbox = extractMailboxPayload(response.body);
        if (!mailbox) {
          return { address, domain };
        }
        if (mailbox.address !== address) {
          throw new Im215ClientError(
            `215.im same-address recreation returned ${mailbox.address} instead of ${address}.`,
            "provider",
            response.status,
          );
        }
        return mailbox;
      }

      if (response.status === 409) {
        const mailbox = extractMailboxPayload(response.body);
        if (mailbox?.address === address) {
          return mailbox;
        }
        return { address, domain };
      }

      throw buildIm215StatusError("recreateMailboxByEmailAddress", response.status, response.body);
    });
  }

  public async listMessages(address: string): Promise<Record<string, unknown>[]> {
    return this.withCredential("poll", address, async (_selection, apiKey) => {
      const response = await requestJson(this.config, apiKey, "GET", "/messages", {
        query: { address },
      });
      if (response.status === 404) {
        return [];
      }
      if (response.status !== 200) {
        throw buildIm215StatusError("listMessages", response.status, response.body);
      }
      return extractMessageList(response.body);
    });
  }

  public async getMessage(messageId: string): Promise<Record<string, unknown>> {
    return this.withCredential("poll", messageId, async (_selection, apiKey) => {
      const response = await requestJson(this.config, apiKey, "GET", `/messages/${encodeURIComponent(messageId)}`);
      if (response.status === 404) {
        return {};
      }
      if (response.status !== 200) {
        throw buildIm215StatusError("getMessage", response.status, response.body);
      }
      const body = asRecord(response.body);
      return asRecord(body.data ?? body.result ?? body);
    });
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: Im215MailboxRefPayload,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const messages = await this.listMessages(mailbox.address);

    for (const item of messages) {
      const sender = readMessageSender(item);
      if (!matchesSenderFilter(sender, fromContains)) {
        continue;
      }

      const messageId = readMessageId(item);
      const subject = readMessageSubject(item);
      const textBody = readMessageText(item);
      const htmlBody = readMessageHtml(item);
      const observedAt = readObservedAt(item) ?? "";

      const summaryOtp = extractOtp({
        subject,
        textBody,
        htmlBody,
      });
      if (summaryOtp) {
        return {
          id: `im215:${messageId ?? summaryOtp.code}`,
          sessionId,
          providerInstanceId,
          observedAt,
          sender,
          subject,
          textBody,
          htmlBody,
          extractedCode: summaryOtp.code,
          codeSource: summaryOtp.source,
        };
      }

      if (!messageId) {
        if (subject || textBody || htmlBody) {
          return {
            id: `im215:${observedAt || sessionId}`,
            sessionId,
            providerInstanceId,
            observedAt,
            sender,
            subject,
            textBody,
            htmlBody,
          };
        }
        continue;
      }

      const detail = await this.getMessage(messageId);
      const detailSender = readMessageSender(detail) ?? sender;
      if (!matchesSenderFilter(detailSender, fromContains)) {
        continue;
      }
      const detailSubject = readMessageSubject(detail) ?? subject;
      const detailText = readMessageText(detail) ?? textBody;
      const detailHtml = readMessageHtml(detail) ?? htmlBody;
      const detailOtp = extractOtp({
        subject: detailSubject,
        textBody: detailText,
        htmlBody: detailHtml,
      });
      return {
        id: `im215:${messageId}`,
        sessionId,
        providerInstanceId,
        observedAt: readObservedAt(detail) ?? observedAt,
        sender: detailSender,
        subject: detailSubject,
        textBody: detailText,
        htmlBody: detailHtml,
        extractedCode: detailOtp?.code,
        codeSource: detailOtp?.source,
      };
    }

    return undefined;
  }
}

export function encodeIm215MailboxRef(instanceId: string, mailbox: Im215MailboxRefPayload): string {
  return `im215:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeIm215MailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): Im215MailboxRefPayload | undefined {
  const prefix = `im215:${expectedInstanceId}:`;
  if (!mailboxRef.trim().startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(mailboxRef.slice(prefix.length))) as Record<string, unknown>;
    const address = readString(payload.address)?.toLowerCase();
    if (!address || !address.includes("@")) {
      return undefined;
    }
    return {
      address,
      mailboxId: readString(payload.mailboxId),
      domain: readString(payload.domain),
      createdAt: readString(payload.createdAt),
      tempToken: readString(payload.tempToken),
    };
  } catch {
    return undefined;
  }
}

export async function probeIm215Instance(
  instance: ProviderInstance,
  credentialSets?: CredentialSetDefinition[],
): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const client = Im215Client.fromInstance(instance, credentialSets);
  if (!client) {
    return {
      ok: false,
      detail: "215.im instance is missing credentialSets/apiKey/keysFile configuration.",
      averageLatencyMs: instance.averageLatencyMs,
    };
  }

  const startedAt = Date.now();
  try {
    const domains = await client.getDomains();
    return {
      ok: domains.length > 0,
      detail: domains.length > 0
        ? `IM215_PROBE_OK: 215.im returned ${domains.length} available domains.`
        : "IM215_MAILBOX_DELIVERY_FAILURE: 215.im returned no available domains.",
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "im215",
        state: domains.length > 0 ? "ok" : "empty-domain-list",
      },
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "im215",
        errorClass: classifyIm215Error(error instanceof Error ? error.message : String(error)),
      },
    };
  }
}

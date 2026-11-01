import type { ObservedMessage, ProviderInstance } from "../../domain/models.js";
import {
  TEMPORAM_DEFAULT_ACCEPT_ENCODING,
  TEMPORAM_DEFAULT_ACCEPT_LANGUAGE,
  TEMPORAM_DEFAULT_BASE_URL,
  TEMPORAM_DEFAULT_USER_AGENT,
  asRecord,
  asRecordList,
  bodyHasTemporamError,
  classifyTemporamError,
  computeSinceIso,
  createRandomLocalPart,
  encodeQuery,
  endpointPath,
  extractOtp,
  formatTemporamError,
  isLegacyTemporamBaseUrl,
  matchesSenderFilter,
  normalizeDomain,
  normalizeLocalPart,
  normalizeMessageRow,
  readMetadata,
  readStringLike,
  requestJson,
  selectDomain,
  sortMessagesNewestFirst,
} from "./support.js";

export interface TemporamConfig {
  baseUrl: string;
  apiKey?: string;
  userAgent: string;
  acceptLanguage: string;
  acceptEncoding: string;
  preferredDomain?: string;
}

export interface TemporamMailboxCredentials {
  email: string;
  localPart: string;
  domain: string;
  openedAt: string;
}

export function resolveTemporamConfig(instance: ProviderInstance): TemporamConfig {
  return {
    baseUrl: readMetadata(instance, "apiBase") ?? readMetadata(instance, "baseUrl") ?? TEMPORAM_DEFAULT_BASE_URL,
    apiKey: readMetadata(instance, "apiKey") ?? readMetadata(instance, "key"),
    userAgent: readMetadata(instance, "userAgent") ?? TEMPORAM_DEFAULT_USER_AGENT,
    acceptLanguage: readMetadata(instance, "acceptLanguage") ?? TEMPORAM_DEFAULT_ACCEPT_LANGUAGE,
    acceptEncoding: readMetadata(instance, "acceptEncoding") ?? TEMPORAM_DEFAULT_ACCEPT_ENCODING,
    preferredDomain: readMetadata(instance, "preferredDomain"),
  };
}

export function encodeTemporamMailboxRef(instanceId: string, mailbox: TemporamMailboxCredentials): string {
  return `temporam:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeTemporamMailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): TemporamMailboxCredentials | undefined {
  const normalizedRef = mailboxRef.trim();
  const normalizedInstanceId = expectedInstanceId.trim();
  if (!normalizedRef || !normalizedInstanceId) {
    return undefined;
  }

  const prefix = `temporam:${normalizedInstanceId}:`;
  if (!normalizedRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(normalizedRef.slice(prefix.length))) as Record<string, unknown>;
    const email = readStringLike(payload.email)?.toLowerCase();
    const localPart = normalizeLocalPart(readStringLike(payload.localPart ?? payload.local_part));
    const domain = normalizeDomain(readStringLike(payload.domain));
    const openedAt = readStringLike(payload.openedAt ?? payload.opened_at);
    if (!email || !email.includes("@") || !localPart || !domain || !openedAt) {
      return undefined;
    }

    const normalizedEmail = `${localPart}@${domain}`;
    if (email !== normalizedEmail) {
      return undefined;
    }

    return {
      email: normalizedEmail,
      localPart,
      domain,
      openedAt,
    };
  } catch {
    return undefined;
  }
}

export class TemporamClient {
  public constructor(private readonly config: TemporamConfig) {}

  public static fromInstance(instance: ProviderInstance): TemporamClient {
    return new TemporamClient(resolveTemporamConfig(instance));
  }

  public async getDomains(): Promise<string[]> {
    const response = await requestJson(this.config, "GET", endpointPath(this.config, "/domains"));
    if (response.status !== 200 || bodyHasTemporamError(response.body)) {
      throw formatTemporamError("getDomains", response.status, response.body);
    }

    const data = Array.isArray(asRecord(response.body).data)
      ? asRecord(response.body).data as unknown[]
      : [];
    return [...new Set(data
      .map((item) => typeof item === "string" ? item : readStringLike(asRecord(item).domain))
      .map((item) => normalizeDomain(item))
      .filter((item): item is string => Boolean(item)))];
  }

  public async createMailbox(options: {
    preferredDomain?: string;
    requestedLocalPart?: string;
    excludedDomains?: string[];
  } = {}): Promise<TemporamMailboxCredentials> {
    const domains = await this.getDomains();
    const domain = selectDomain(
      domains,
      options.preferredDomain ?? this.config.preferredDomain,
      options.excludedDomains,
    );
    const localPart = normalizeLocalPart(options.requestedLocalPart) ?? createRandomLocalPart(8);
    return {
      email: `${localPart}@${domain}`,
      localPart,
      domain,
      openedAt: new Date().toISOString(),
    };
  }

  public async listMessages(
    email: string,
    since: string,
    limit = 50,
  ): Promise<Record<string, unknown>[]> {
    const normalizedEmail = readStringLike(email)?.toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      return [];
    }

    const query = encodeQuery([
      ["email", normalizedEmail],
      ...(isLegacyTemporamBaseUrl(this.config.baseUrl)
        ? [["since", since] as [string, string | number | undefined]]
        : [["page", 1] as [string, string | number | undefined]]),
      ["limit", limit],
    ]);
    const response = await requestJson(this.config, "GET", `${endpointPath(this.config, "/emails")}${query}`);
    if (response.status !== 200 || bodyHasTemporamError(response.body)) {
      throw formatTemporamError("listMessages", response.status, response.body);
    }

    return asRecordList(asRecord(response.body).data);
  }

  public async getMessage(messageId: string): Promise<Record<string, unknown>> {
    const normalizedMessageId = readStringLike(messageId);
    if (!normalizedMessageId) {
      return {};
    }

    const response = await requestJson(this.config, "GET", endpointPath(this.config, `/emails/${encodeURIComponent(normalizedMessageId)}`));
    if (response.status === 404) {
      return {};
    }
    if (response.status !== 200 || bodyHasTemporamError(response.body)) {
      throw formatTemporamError("getMessage", response.status, response.body);
    }

    return asRecord(asRecord(response.body).data);
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: TemporamMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const messages = sortMessagesNewestFirst(
      await this.listMessages(mailbox.email, computeSinceIso(mailbox.openedAt), 50),
    );

    for (const row of messages) {
      const summary = normalizeMessageRow(row, sessionId);
      if (!matchesSenderFilter(summary.sender, fromContains)) {
        continue;
      }

      const summaryOtp = extractOtp({ subject: summary.subject, textBody: summary.textBody, htmlBody: summary.htmlBody });
      if (summaryOtp) {
        return {
          id: `temporam:${summary.id}`,
          sessionId,
          providerInstanceId,
          observedAt: summary.observedAt,
          sender: summary.sender,
          subject: summary.subject,
          textBody: summary.textBody,
          htmlBody: summary.htmlBody,
          extractedCode: summaryOtp.code,
          extractedCandidates: summaryOtp.candidates,
          codeSource: summaryOtp.source,
        };
      }

      const detailRow = await this.getMessage(summary.id);
      const detail = normalizeMessageRow({ ...row, ...detailRow }, summary.id);
      if (!matchesSenderFilter(detail.sender, fromContains)) {
        continue;
      }

      const detailOtp = extractOtp({
        subject: detail.subject,
        textBody: detail.textBody,
        htmlBody: detail.htmlBody,
      });

      return {
        id: `temporam:${detail.id}`,
        sessionId,
        providerInstanceId,
        observedAt: detail.observedAt,
        sender: detail.sender,
        subject: detail.subject,
        textBody: detail.textBody,
        htmlBody: detail.htmlBody,
        extractedCode: detailOtp?.code,
        extractedCandidates: detailOtp?.candidates,
        codeSource: detailOtp?.source,
      };
    }

    return undefined;
  }
}

export async function probeTemporamInstance(instance: ProviderInstance): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const client = TemporamClient.fromInstance(instance);
  const startedAt = Date.now();
  try {
    const domains = await client.getDomains();
    return {
      ok: domains.length > 0,
      detail: domains.length > 0
        ? `Temporam returned ${domains.length} available domain${domains.length === 1 ? "" : "s"}.`
        : "Temporam returned no available domains.",
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "temporam",
        state: domains.length > 0 ? "ok" : "empty-domain-list",
        ...(domains.length > 0 ? { domainsCsv: domains.join(",") } : {}),
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const errorClass = classifyTemporamError(detail);
    return {
      ok: false,
      detail,
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "temporam",
        errorClass,
        ...(errorClass === "configuration" ? { state: "missing-api-key" } : {}),
      },
    };
  }
}

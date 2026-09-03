import type { ObservedMessage, ProviderInstance } from "../../domain/models.js";
import { resolveM2uConfig } from "./configuration.js";
import { classifyM2uError, formatM2uError, hasM2uBodyError } from "./failure.js";
import { requestJson } from "./http.js";
import { readStringLike, resolveCachedProbeMailboxSmokeResult } from "./metadata.js";
import {
  asRecord,
  asRecordList,
  computeDomainMatchAttempts,
  domainMatchesPreference,
  encodeQuery,
  extractOtp,
  matchesSenderFilter,
  normalizeFilter,
  normalizeLocalPart,
  resolvePreferredDomains,
} from "./payload.js";
import type { M2uConfig, M2uMailboxCredentials } from "./types.js";

export { resolveM2uConfig } from "./configuration.js";
export { setM2uExecFileForTesting } from "./http.js";
export { decodeM2uMailboxRef, encodeM2uMailboxRef } from "./mailbox-ref.js";
export type { M2uConfig, M2uMailboxCredentials } from "./types.js";

export class M2uClient {
  public constructor(private readonly config: M2uConfig) {}

  public static fromInstance(instance: ProviderInstance): M2uClient {
    return new M2uClient(resolveM2uConfig(instance));
  }

  public async getDomains(): Promise<string[]> {
    const response = await requestJson(this.config, "GET", "/v1/domains");
    if (response.status !== 200 || hasM2uBodyError(response.body)) {
      throw formatM2uError("getDomains", response.status, response.body);
    }

    const domains = Array.isArray(asRecord(response.body).domains)
      ? asRecord(response.body).domains as unknown[]
      : [];
    return domains
      .map((item) => readStringLike(item))
      .filter((item): item is string => Boolean(item));
  }

  public async createMailbox(options: {
    token?: string;
    preferredDomain?: string;
    requestedLocalPart?: string;
    turnstileToken?: string;
  } = {}): Promise<M2uMailboxCredentials> {
    const preferredDomain = normalizeFilter(options.preferredDomain ?? this.config.preferredDomain);
    const requestedLocalPart = normalizeLocalPart(options.requestedLocalPart);
    const turnstileToken = normalizeLocalPart(options.turnstileToken);

    // Registration needs a usable mailbox, so a missing Turnstile token degrades to the auto flow.
    if (requestedLocalPart && preferredDomain && turnstileToken) {
      return await this.createCustomMailbox({
        localPart: requestedLocalPart,
        domain: preferredDomain,
        turnstileToken,
      });
    }

    let preferredDomains: string[] = [];
    let attempts = 1;

    if (preferredDomain) {
      const domains = await this.getDomains();
      preferredDomains = resolvePreferredDomains(domains, preferredDomain);
      if (preferredDomains.length === 0) {
        throw new Error(`M2U_PROVIDER_FAILURE: M2U has no available domains matching "${preferredDomain}".`);
      }
      attempts = computeDomainMatchAttempts(domains.length, preferredDomains.length);
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const requestedDomain = preferredDomains.length > 0
        ? preferredDomains[attempt % preferredDomains.length]
        : undefined;
      const payload = {
        ...(options.token?.trim() ? { token: options.token.trim() } : {}),
        ...(requestedDomain ? { domain: requestedDomain } : {}),
      };
      const response = await requestJson(this.config, "POST", "/v1/mailboxes/auto", {
        jsonBody: payload,
      });

      if ((response.status !== 200 && response.status !== 201) || hasM2uBodyError(response.body)) {
        throw formatM2uError("createMailbox", response.status, response.body);
      }

      const mailbox = asRecord(asRecord(response.body).mailbox);
      const localPart = readStringLike(mailbox.local_part);
      const domain = normalizeFilter(readStringLike(mailbox.domain));
      const token = readStringLike(mailbox.token);
      const viewToken = readStringLike(mailbox.view_token);
      if (!localPart || !domain || !token || !viewToken) {
        throw new Error("M2U_PROVIDER_FAILURE: M2U createMailbox returned an incomplete mailbox payload.");
      }

      if (preferredDomain && !domainMatchesPreference(domain, preferredDomain)) {
        continue;
      }

      return {
        email: `${localPart}@${domain}`.toLowerCase(),
        token,
        viewToken,
        mailboxId: readStringLike(mailbox.id),
        expiresAt: readStringLike(mailbox.expires_at),
      };
    }

    throw new Error(`M2U_PROVIDER_FAILURE: M2U could not obtain a mailbox matching "${preferredDomain}" after ${attempts} attempts.`);
  }

  private async createCustomMailbox(input: {
    localPart: string;
    domain: string;
    turnstileToken: string;
  }): Promise<M2uMailboxCredentials> {
    const response = await requestJson(this.config, "POST", "/v1/mailboxes/custom", {
      jsonBody: {
        localPart: input.localPart,
        domain: input.domain,
        turnstileToken: input.turnstileToken,
      },
    });

    if ((response.status !== 200 && response.status !== 201) || hasM2uBodyError(response.body)) {
      throw formatM2uError("createCustomMailbox", response.status, response.body);
    }

    const mailbox = asRecord(asRecord(response.body).mailbox);
    const localPart = readStringLike(mailbox.local_part);
    const domain = normalizeFilter(readStringLike(mailbox.domain));
    const token = readStringLike(mailbox.token);
    const viewToken = readStringLike(mailbox.view_token);
    if (!localPart || !domain || !token || !viewToken) {
      throw new Error("M2U_PROVIDER_FAILURE: M2U createCustomMailbox returned an incomplete mailbox payload.");
    }

    if (localPart !== input.localPart || !domainMatchesPreference(domain, input.domain)) {
      throw new Error(
        `M2U_PROVIDER_FAILURE: M2U custom mailbox returned mismatched address requested=${input.localPart}@${input.domain} actual=${localPart}@${domain}.`,
      );
    }

    return {
      email: `${localPart}@${domain}`.toLowerCase(),
      token,
      viewToken,
      mailboxId: readStringLike(mailbox.id),
      expiresAt: readStringLike(mailbox.expires_at),
    };
  }

  public async listMessages(token: string, viewToken: string): Promise<Record<string, unknown>[]> {
    const response = await requestJson(
      this.config,
      "GET",
      `/v1/mailboxes/${encodeURIComponent(token)}${"/messages"}${encodeQuery({ view: viewToken })}`,
    );
    if (response.status === 429 || response.status >= 500 || hasM2uBodyError(response.body)) {
      throw formatM2uError("listMessages", response.status, response.body);
    }
    if (response.status !== 200) {
      return [];
    }

    return asRecordList(asRecord(response.body).messages);
  }

  public async getMessage(token: string, viewToken: string, messageId: string): Promise<Record<string, unknown>> {
    const response = await requestJson(
      this.config,
      "GET",
      `/v1/mailboxes/${encodeURIComponent(token)}/messages/${encodeURIComponent(messageId)}${encodeQuery({ view: viewToken })}`,
    );
    if (response.status === 429 || response.status >= 500 || hasM2uBodyError(response.body)) {
      throw formatM2uError("getMessage", response.status, response.body);
    }
    if (response.status !== 200) {
      return {};
    }

    return asRecord(asRecord(response.body).message);
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: M2uMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const messages = await this.listMessages(mailbox.token, mailbox.viewToken);

    for (const item of messages) {
      const messageId = readStringLike(item.id) ?? sessionId;
      const sender = readStringLike(item.from_addr ?? item.from);
      if (!matchesSenderFilter(sender, fromContains)) {
        continue;
      }

      const subject = readStringLike(item.subject);
      const summaryOtp = extractOtp({ subject });
      if (summaryOtp) {
        return {
          id: `m2u:${messageId}`,
          sessionId,
          providerInstanceId,
          observedAt: readStringLike(item.received_at) ?? "",
          sender,
          subject,
          extractedCode: summaryOtp.code,
          extractedCandidates: summaryOtp.candidates,
          codeSource: summaryOtp.source,
        };
      }

      const detail = await this.getMessage(mailbox.token, mailbox.viewToken, messageId);
      const detailSender = readStringLike(detail.from_addr ?? detail.from) ?? sender;
      if (!matchesSenderFilter(detailSender, fromContains)) {
        continue;
      }

      const detailSubject = readStringLike(detail.subject) ?? subject;
      const textBody = readStringLike(detail.text_body ?? detail.textBody ?? detail.text);
      const htmlBody = readStringLike(detail.html_body ?? detail.htmlBody ?? detail.html);
      const detailOtp = extractOtp({
        subject: detailSubject,
        textBody,
        htmlBody,
      });

      return {
        id: `m2u:${messageId}`,
        sessionId,
        providerInstanceId,
        observedAt: readStringLike(detail.received_at) ?? readStringLike(item.received_at) ?? "",
        sender: detailSender,
        subject: detailSubject,
        textBody,
        htmlBody,
        extractedCode: detailOtp?.code,
        extractedCandidates: detailOtp?.candidates,
        codeSource: detailOtp?.source,
      };
    }

    return undefined;
  }
}

export async function probeM2uInstance(instance: ProviderInstance): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const client = M2uClient.fromInstance(instance);
  const startedAt = Date.now();
  try {
    const domains = await client.getDomains();
    const nowMs = Date.now();
    const cachedSmoke = resolveCachedProbeMailboxSmokeResult(instance, nowMs);
    if (cachedSmoke) {
      return {
        ok: cachedSmoke.ok && domains.length > 0,
        detail: cachedSmoke.detail,
        averageLatencyMs: nowMs - startedAt,
        metadata: {
          provider: "m2u",
          state: cachedSmoke.ok && domains.length > 0 ? "ok" : "probe_mailbox_smoke_failed",
          ...(domains.length > 0 ? { domainsCsv: domains.join(",") } : {}),
          ...cachedSmoke.metadata,
        },
      };
    }

    const mailbox = await client.createMailbox();
    const smokeDetail = `M2U createMailbox smoke check succeeded: ${mailbox.email}`;
    return {
      ok: domains.length > 0,
      detail: domains.length > 0
        ? smokeDetail
        : "M2U returned no available domains.",
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "m2u",
        state: domains.length > 0 ? "ok" : "empty-domain-list",
        ...(domains.length > 0 ? { domainsCsv: domains.join(",") } : {}),
        lastProbeCreateMailboxAt: new Date().toISOString(),
        lastProbeCreateMailboxOk: "true",
        lastProbeCreateMailboxEmail: mailbox.email,
        lastProbeCreateMailboxDetail: smokeDetail,
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const classification = classifyM2uError(detail);
    return {
      ok: false,
      detail,
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "m2u",
        errorClass: classification,
        lastProbeCreateMailboxAt: new Date().toISOString(),
        lastProbeCreateMailboxOk: "false",
        lastProbeCreateMailboxDetail: detail,
      },
    };
  }
}

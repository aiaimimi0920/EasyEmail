import type { ObservedMessage, ProviderInstance } from "../../domain/models.js";
import {
  asRecord,
  classifyEtempmailError,
  extractDomainOptions,
  extractHtmlBodyFromDetailPage,
  extractInboxRows,
  extractMailbox,
  extractOtp,
  formatEtempmailError,
  htmlToText,
  looksLikeSubjectOnlyOtp,
  matchesSenderFilter,
  mergeCookieHeaders,
  normalizeCookieHeader,
  normalizeDomain,
  normalizeEmailAddress,
  parseJsonBody,
  readMetadata,
  readStringLike,
  requestRaw,
  toObservedAt,
  type EtempmailConfig,
  type EtempmailDomainOption,
  type EtempmailMailboxCredentials,
  type EtempmailMailboxOpenState,
} from "./protocol.js";

export type { EtempmailConfig, EtempmailMailboxCredentials } from "./protocol.js";
export function resolveEtempmailConfig(instance: ProviderInstance): EtempmailConfig {
  return {
    apiBase: readMetadata(instance, "apiBase") ?? "https://etempmail.com",
    preferredDomain: readMetadata(instance, "preferredDomain"),
  };
}

export function encodeEtempmailMailboxRef(instanceId: string, mailbox: EtempmailMailboxCredentials): string {
  return `etempmail:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeEtempmailMailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): EtempmailMailboxCredentials | undefined {
  const normalizedRef = mailboxRef.trim();
  const normalizedInstanceId = expectedInstanceId.trim();
  if (!normalizedRef || !normalizedInstanceId) {
    return undefined;
  }

  const prefix = `etempmail:${normalizedInstanceId}:`;
  if (!normalizedRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(normalizedRef.slice(prefix.length))) as Record<string, unknown>;
    const email = normalizeEmailAddress(readStringLike(payload.email));
    const recoverKey = readStringLike(payload.recoverKey) ?? readStringLike(payload.recover_key);
    if (!email || !recoverKey) {
      return undefined;
    }

    return {
      email,
      recoverKey,
      mailboxId: readStringLike(payload.mailboxId) ?? readStringLike(payload.id),
      creationTime: readStringLike(payload.creationTime) ?? readStringLike(payload.creation_time),
      sessionCookieHeader: normalizeCookieHeader(
        readStringLike(payload.sessionCookieHeader) ?? readStringLike(payload.cookieHeader),
      ),
    };
  } catch {
    return undefined;
  }
}

export class EtempmailClient {
  public constructor(private readonly config: EtempmailConfig) {}

  public static fromInstance(instance: ProviderInstance): EtempmailClient {
    return new EtempmailClient(resolveEtempmailConfig(instance));
  }

  private async seedMailboxSession(cookieHeader?: string): Promise<string | undefined> {
    const response = await requestRaw(this.config, "GET", "/", {
      cookieHeader,
      accept: "text/html,application/xhtml+xml",
    });
    if (response.status !== 200) {
      return normalizeCookieHeader(cookieHeader);
    }
    return mergeCookieHeaders(cookieHeader, response.setCookie);
  }

  private async getMailboxIdentity(cookieHeader?: string): Promise<EtempmailMailboxOpenState> {
    const seededCookieHeader = normalizeCookieHeader(cookieHeader) ?? await this.seedMailboxSession();
    const response = await requestRaw(this.config, "POST", "/getEmailAddress", {
      cookieHeader: seededCookieHeader,
      body: "",
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      xRequestedWith: true,
    });
    if (response.status !== 200) {
      throw formatEtempmailError("getEmailAddress", response.status, response.bodyText.slice(0, 200));
    }

    const mailbox = extractMailbox(parseJsonBody(response.bodyText));
    if (!mailbox) {
      throw new Error("eTempMail getEmailAddress returned an incomplete mailbox payload.");
    }

    const nextCookieHeader = mergeCookieHeaders(seededCookieHeader, response.setCookie);
    if (!nextCookieHeader) {
      throw new Error("eTempMail getEmailAddress did not return a session cookie.");
    }

    return {
      mailbox: {
        ...mailbox,
        sessionCookieHeader: nextCookieHeader,
      },
      cookieHeader: nextCookieHeader,
    };
  }

  private async getAvailableDomainOptions(cookieHeader?: string): Promise<EtempmailDomainOption[]> {
    const response = await requestRaw(this.config, "GET", "/", {
      cookieHeader,
      accept: "text/html,application/xhtml+xml",
    });
    if (response.status !== 200) {
      return [];
    }
    return extractDomainOptions(response.bodyText);
  }

  private async changeMailboxDomain(cookieHeader: string, domainId: string): Promise<string | undefined> {
    const response = await requestRaw(this.config, "POST", "/changeEmailAddress", {
      cookieHeader,
      body: new URLSearchParams({ id: domainId }).toString(),
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      xRequestedWith: true,
      accept: "text/html,application/xhtml+xml",
    });
    if (response.status !== 200) {
      return undefined;
    }
    return mergeCookieHeaders(cookieHeader, response.setCookie) ?? normalizeCookieHeader(cookieHeader);
  }

  private async recoverMailboxCookie(recoverKey: string, cookieHeader?: string): Promise<string> {
    const seededCookieHeader = normalizeCookieHeader(cookieHeader) ?? await this.seedMailboxSession();
    const response = await requestRaw(this.config, "POST", "/recoverEmailAddress", {
      cookieHeader: seededCookieHeader,
      body: new URLSearchParams({ key: recoverKey }).toString(),
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      xRequestedWith: true,
    });
    if (response.status !== 200) {
      throw formatEtempmailError("recoverEmailAddress", response.status, response.bodyText.slice(0, 200));
    }

    const body = asRecord(parseJsonBody(response.bodyText));
    if (body.success !== true) {
      throw new Error(`eTempMail recoverEmailAddress failed: ${readStringLike(body.message) ?? "unknown error"}`);
    }

    const nextCookieHeader = mergeCookieHeaders(seededCookieHeader, response.setCookie);
    if (!nextCookieHeader) {
      throw new Error("eTempMail recoverEmailAddress did not return a session cookie.");
    }

    return nextCookieHeader;
  }

  public async createMailbox(
    options: {
      requestedDomain?: string;
    } = {},
  ): Promise<EtempmailMailboxCredentials> {
    let state = await this.getMailboxIdentity();
    const requestedDomain = normalizeDomain(options.requestedDomain ?? this.config.preferredDomain);
    const currentDomain = normalizeDomain(state.mailbox.email.split("@")[1]);

    if (requestedDomain && currentDomain && requestedDomain !== currentDomain) {
      const domainOptions = await this.getAvailableDomainOptions(state.cookieHeader);
      const matched = domainOptions.find((item) => item.domain === requestedDomain);
      if (matched) {
        const changedCookieHeader = await this.changeMailboxDomain(state.cookieHeader, matched.id);
        if (changedCookieHeader) {
          try {
            state = await this.getMailboxIdentity(changedCookieHeader);
          } catch {
            // Keep the initial mailbox when domain switching fails mid-flight.
          }
        }
      }
    }

    return state.mailbox;
  }

  private async getInboxRows(
    mailbox: EtempmailMailboxCredentials,
    cookieHeader?: string,
  ): Promise<{ cookieHeader: string; rows: Record<string, unknown>[] }> {
    const preferredCookieHeader = normalizeCookieHeader(cookieHeader) ?? normalizeCookieHeader(mailbox.sessionCookieHeader);
    const effectiveCookieHeader = preferredCookieHeader || await this.recoverMailboxCookie(mailbox.recoverKey);
    const response = await requestRaw(this.config, "POST", "/getInbox", {
      cookieHeader: effectiveCookieHeader,
      body: "",
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      xRequestedWith: true,
    });
    if (response.status !== 200) {
      if (preferredCookieHeader) {
        const recoveredCookieHeader = await this.recoverMailboxCookie(mailbox.recoverKey, preferredCookieHeader);
        const recoveredResponse = await requestRaw(this.config, "POST", "/getInbox", {
          cookieHeader: recoveredCookieHeader,
          body: "",
          contentType: "application/x-www-form-urlencoded; charset=UTF-8",
          xRequestedWith: true,
        });
        if (recoveredResponse.status !== 200) {
          throw formatEtempmailError("getInbox", recoveredResponse.status, recoveredResponse.bodyText.slice(0, 200));
        }

        return {
          cookieHeader: recoveredCookieHeader,
          rows: extractInboxRows(parseJsonBody(recoveredResponse.bodyText)),
        };
      }
      throw formatEtempmailError("getInbox", response.status, response.bodyText.slice(0, 200));
    }

    return {
      cookieHeader: effectiveCookieHeader,
      rows: extractInboxRows(parseJsonBody(response.bodyText)),
    };
  }

  private async getMessageDetailByIndex(
    mailbox: EtempmailMailboxCredentials,
    index: number,
    cookieHeader?: string,
  ): Promise<{ textBody: string; htmlBody: string }> {
    const effectiveCookieHeader = cookieHeader?.trim() || await this.recoverMailboxCookie(mailbox.recoverKey);
    const response = await requestRaw(
      this.config,
      "GET",
      `/email?id=${encodeURIComponent(String(index))}`,
      {
        cookieHeader: effectiveCookieHeader,
        accept: "text/html,application/xhtml+xml",
      },
    );
    if (response.status !== 200) {
      throw formatEtempmailError("getMessageDetail", response.status, response.bodyText.slice(0, 200));
    }

    return extractHtmlBodyFromDetailPage(response.bodyText);
  }

  public async deleteMailbox(mailbox: EtempmailMailboxCredentials): Promise<{ released: boolean; detail: string }> {
    const cookieHeader = normalizeCookieHeader(mailbox.sessionCookieHeader)
      ?? await this.recoverMailboxCookie(mailbox.recoverKey);
    const response = await requestRaw(this.config, "POST", "/deleteEmailAddress", {
      cookieHeader,
      xRequestedWith: true,
    });

    if (response.status === 404) {
      return {
        released: false,
        detail: "already_deleted",
      };
    }
    if (response.status !== 200 && response.status !== 204) {
      throw formatEtempmailError("deleteEmailAddress", response.status, response.bodyText.slice(0, 200));
    }

    return {
      released: true,
      detail: "deleted",
    };
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: EtempmailMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const { cookieHeader, rows } = await this.getInboxRows(mailbox);

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const sender = readStringLike(row.from) ?? readStringLike(row.sender);
      if (!matchesSenderFilter(sender, fromContains)) {
        continue;
      }

      const subject = readStringLike(row.subject);
      const inlineHtmlBody = readStringLike(row.body) ?? readStringLike(row.htmlBody) ?? readStringLike(row.html);
      const inlineTextBody = inlineHtmlBody ? htmlToText(inlineHtmlBody) : readStringLike(row.textBody) ?? readStringLike(row.text);
      const summaryOtp = extractOtp({ subject });
      const inlineOtp = extractOtp({
        subject,
        textBody: inlineTextBody,
        htmlBody: inlineHtmlBody,
      });
      const observedMessageId = `etempmail:${readStringLike(row.id) ?? String(index + 1)}`;
      const observedAt = toObservedAt(row.date ?? row.createdAt);
      const summaryResult = summaryOtp
        ? {
            id: observedMessageId,
            sessionId,
            providerInstanceId,
            observedAt,
            sender,
            subject,
            textBody: inlineTextBody ?? "",
            htmlBody: inlineHtmlBody ?? "",
            extractedCode: summaryOtp.code,
            ...(summaryOtp.candidates ? { extractedCandidates: summaryOtp.candidates } : {}),
            codeSource: summaryOtp.source,
          }
        : undefined;
      if (inlineOtp) {
        return {
          id: observedMessageId,
          sessionId,
          providerInstanceId,
          observedAt,
          sender,
          subject,
          textBody: inlineTextBody ?? "",
          htmlBody: inlineHtmlBody ?? "",
          extractedCode: inlineOtp.code,
          ...(inlineOtp.candidates ? { extractedCandidates: inlineOtp.candidates } : {}),
          codeSource: inlineOtp.source,
        };
      }
      if (summaryOtp && looksLikeSubjectOnlyOtp(summaryOtp.code)) {
        return summaryResult;
      }

      let detail: { textBody: string; htmlBody: string };
      try {
        detail = await this.getMessageDetailByIndex(mailbox, index + 1, cookieHeader);
      } catch (error) {
        if (summaryResult) {
          return summaryResult;
        }
        throw error;
      }
      const detailOtp = extractOtp({
        subject,
        textBody: detail.textBody,
        htmlBody: detail.htmlBody,
      });
      if (!detailOtp) {
        if (summaryResult) {
          return summaryResult;
        }
        continue;
      }

      return {
        id: observedMessageId,
        sessionId,
        providerInstanceId,
        observedAt,
        sender,
        subject,
        textBody: detail.textBody,
        htmlBody: detail.htmlBody,
        extractedCode: detailOtp.code,
        ...(detailOtp.candidates ? { extractedCandidates: detailOtp.candidates } : {}),
        codeSource: detailOtp.source,
      };
    }

    return undefined;
  }
}

export async function probeEtempmailInstance(instance: ProviderInstance): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const client = EtempmailClient.fromInstance(instance);
  const startedAt = Date.now();

  let mailbox: EtempmailMailboxCredentials | undefined;
  try {
    mailbox = await client.createMailbox();
    await client.tryReadLatestCode("probe-session", mailbox, instance.id);
    return {
      ok: true,
      detail: `ETEMPMAIL_PROBE_OK: ${mailbox.email}`,
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "etempmail",
        state: "ok",
        selectedDomain: mailbox.email.split("@")[1] || "",
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      detail,
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "etempmail",
        errorClass: classifyEtempmailError(detail),
      },
    };
  } finally {
    if (mailbox) {
      try {
        await client.deleteMailbox(mailbox);
      } catch {
        // Ignore cleanup failures during probe.
      }
    }
  }
}

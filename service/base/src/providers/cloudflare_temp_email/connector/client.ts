declare const fetch: (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

import { extractOtpFromContent } from "../../../domain/otp.js";
import type { ObservedMessage, ProviderInstance } from "../../../domain/models.js";
import { parseDomainWeights, pickWeightedDomainFamily, resolveCloudflareTempEmailConfig } from "./configuration.js";
import { extractErrorDetail, requestAdminJson, requestJson } from "./http.js";
import { asMailItems, asRecord, extractObservedAtFromRaw, parseRawMailBodies, parseRawMailHeader } from "./mail-content.js";
import type {
  CloudflareTempAdminAddressRecord,
  CloudflareTempEmailConfig,
  CloudflareTempEmailSendResult,
  CloudflareTempMailboxCredentials,
  MailCreateAddressResponse,
  MailCreateMailItem,
  MailCreateParsedMailResponse,
  MailDeleteAddressResponse,
} from "./models.js";

export { resolveCloudflareTempEmailConfig } from "./configuration.js";
export {
  decodeCloudflareTempMailboxRef,
  encodeCloudflareTempMailboxRef,
} from "./models.js";
export type {
  CloudflareTempEmailConfig,
  CloudflareTempEmailSendResult,
  CloudflareTempMailboxCredentials,
} from "./models.js";
export { probeCloudflareTempEmailInstance } from "./probe.js";

export class CloudflareTempEmailCreateClient {
  public constructor(
    private readonly config: CloudflareTempEmailConfig,
    private readonly domainWeights: Record<string, number> = {},
  ) {}

  public static fromInstance(instance: ProviderInstance): CloudflareTempEmailCreateClient | undefined {
    const config = resolveCloudflareTempEmailConfig(instance);
    return config ? new CloudflareTempEmailCreateClient(config, parseDomainWeights(instance)) : undefined;
  }

  private selectDomain(requestedDomain?: string, requestRandomSubdomain = false): string | undefined {
    const forced = requestedDomain?.trim().toLowerCase();
    if (forced) {
      return forced;
    }

    const configuredDomains = requestRandomSubdomain && this.config.randomSubdomainDomains.length > 0
      ? this.config.randomSubdomainDomains
      : (this.config.domains.length > 0
        ? this.config.domains
        : (this.config.domain?.trim() ? [this.config.domain.trim().toLowerCase()] : []));
    return pickWeightedDomainFamily(configuredDomains, this.domainWeights);
  }

  public async newAddress(
    name?: string,
    options: {
      requestedDomain?: string;
      requestRandomSubdomain?: boolean;
    } = {},
  ): Promise<CloudflareTempMailboxCredentials> {
    const requestRandomSubdomain = options.requestRandomSubdomain === true;
    const resolvedDomain = this.selectDomain(options.requestedDomain, requestRandomSubdomain);
    const requestAddress = async (domain?: string) => await requestJson(this.config, "POST", "/api/new_address", {
      jsonBody: {
        name: name?.trim() || "",
        ...(domain ? { domain } : {}),
        ...(requestRandomSubdomain ? { enableRandomSubdomain: true } : {}),
      },
    });
    let response = await requestAddress(resolvedDomain);
    const initialFailureDetail = response.status === 400
      ? extractErrorDetail(response.body, response.rawText)
      : "";
    if (
      response.status === 400
      && resolvedDomain
      && !options.requestedDomain?.trim()
      && /(?:invalid domain|无效的域名)/i.test(initialFailureDetail)
    ) {
      response = await requestAddress();
    }
    if (response.status !== 200) {
      const detail = extractErrorDetail(response.body, response.rawText);
      throw new Error(`Cloudflare Temp Email newAddress failed with status ${response.status}${detail ? `: ${detail}` : "."}`);
    }

    const body = asRecord(response.body) as MailCreateAddressResponse;
    const address = typeof body.address === "string" ? body.address.trim() : "";
    const jwt = typeof body.jwt === "string" ? body.jwt.trim() : "";
    if (!address || !jwt) {
      throw new Error("Cloudflare Temp Email newAddress returned an empty address or jwt.");
    }

    return { address, jwt };
  }

  public async deleteMailbox(
    mailbox: CloudflareTempMailboxCredentials,
  ): Promise<{ released: boolean; detail: string }> {
    const response = await requestJson(this.config, "DELETE", "/api/delete_address", {
      bearerToken: mailbox.jwt,
    });
    if (response.status !== 200) {
      const detail = extractErrorDetail(response.body, response.rawText);
      throw new Error(`Cloudflare Temp Email deleteAddress failed with status ${response.status}${detail ? `: ${detail}` : "."}`);
    }

    const body = asRecord(response.body) as MailDeleteAddressResponse;
    return body.success === true
      ? { released: true, detail: "deleted" }
      : { released: false, detail: "delete_failed" };
  }

  public async recoverMailboxByEmail(emailAddress: string): Promise<CloudflareTempMailboxCredentials | undefined> {
    const normalizedEmail = emailAddress.trim().toLowerCase();
    if (!normalizedEmail) {
      return undefined;
    }

    const encodedQuery = encodeURIComponent(normalizedEmail);
    const addressResponse = await requestAdminJson(
      this.config,
      "GET",
      `/admin/address?query=${encodedQuery}&limit=20&offset=0`,
    );
    if (addressResponse.status !== 200) {
      const detail = extractErrorDetail(addressResponse.body, addressResponse.rawText);
      throw new Error(`Cloudflare Temp Email admin address query failed with status ${addressResponse.status}${detail ? `: ${detail}` : "."}`);
    }

    const addressBody = asRecord(addressResponse.body);
    const results = Array.isArray(addressBody.results) ? addressBody.results : [];
    const match = results
      .map((item) => asRecord(item) as CloudflareTempAdminAddressRecord)
      .find((item) => typeof item.name === "string" && item.name.trim().toLowerCase() === normalizedEmail);
    if (!match?.id) {
      return undefined;
    }

    const jwtResponse = await requestAdminJson(
      this.config,
      "GET",
      `/admin/show_password/${encodeURIComponent(String(match.id))}`,
    );
    if (jwtResponse.status !== 200) {
      const detail = extractErrorDetail(jwtResponse.body, jwtResponse.rawText);
      throw new Error(`Cloudflare Temp Email admin JWT recovery failed with status ${jwtResponse.status}${detail ? `: ${detail}` : "."}`);
    }

    const jwtBody = asRecord(jwtResponse.body);
    const jwt = typeof jwtBody.jwt === "string" ? jwtBody.jwt.trim() : "";
    if (!jwt) {
      throw new Error(`Cloudflare Temp Email admin JWT recovery returned an empty jwt for ${normalizedEmail}.`);
    }

    return {
      address: normalizedEmail,
      jwt,
    };
  }

  public async listMails(jwt: string, limit = 20, offset = 0): Promise<MailCreateMailItem[]> {
    const response = await requestJson(this.config, "GET", "/api/mails", {
      bearerToken: jwt,
      limit,
      offset,
    });
    if (response.status !== 200) {
      const detail = extractErrorDetail(response.body, response.rawText);
      throw new Error(`Cloudflare Temp Email listMails failed with status ${response.status}${detail ? `: ${detail}` : "."}`);
    }

    const body = asRecord(response.body);
    return asMailItems(body.results ?? body.emails ?? body.data);
  }

  public async getMail(jwt: string, mailId: number): Promise<Record<string, unknown>> {
    const response = await requestJson(this.config, "GET", `/api/mail/${encodeURIComponent(String(mailId))}`, {
      bearerToken: jwt,
    });
    if (response.status !== 200) {
      const detail = extractErrorDetail(response.body, response.rawText);
      throw new Error(`Cloudflare Temp Email getMail failed with status ${response.status}${detail ? `: ${detail}` : "."}`);
    }

    return asRecord(response.body);
  }

  public async getParsedMail(jwt: string, mailId: number): Promise<MailCreateParsedMailResponse> {
    const response = await requestJson(this.config, "GET", `/api/parsed_mail/${encodeURIComponent(String(mailId))}`, {
      bearerToken: jwt,
    });
    if (response.status !== 200) {
      const detail = extractErrorDetail(response.body, response.rawText);
      throw new Error(`Cloudflare Temp Email getParsedMail failed with status ${response.status}${detail ? `: ${detail}` : "."}`);
    }

    return asRecord(response.body) as MailCreateParsedMailResponse;
  }

  public async requestSendMailAccess(jwt: string): Promise<void> {
    const response = await requestJson(this.config, "POST", "/api/request_send_mail_access", {
      bearerToken: jwt,
      jsonBody: {},
    });
    if (response.status !== 200) {
      const detail = extractErrorDetail(response.body, response.rawText);
      throw new Error(`Cloudflare Temp Email requestSendMailAccess failed with status ${response.status}${detail ? `: ${detail}` : "."}`);
    }
  }

  private async sendMailWithMailboxToken(
    mailbox: CloudflareTempMailboxCredentials,
    request: {
      toEmailAddress: string;
      toName?: string;
      subject: string;
      textBody?: string;
      htmlBody?: string;
      fromName?: string;
    },
  ): Promise<void> {
    const response = await requestJson(this.config, "POST", "/api/send_mail", {
      bearerToken: mailbox.jwt,
      jsonBody: {
        from_name: request.fromName?.trim() || "",
        to_mail: request.toEmailAddress,
        to_name: request.toName?.trim() || "",
        subject: request.subject,
        content: request.htmlBody?.trim() ? request.htmlBody : (request.textBody ?? ""),
        is_html: Boolean(request.htmlBody?.trim()),
      },
    });
    if (response.status !== 200) {
      const detail = extractErrorDetail(response.body, response.rawText);
      throw new Error(`Cloudflare Temp Email sendMail failed with status ${response.status}${detail ? `: ${detail}` : "."}`);
    }
  }

  private async sendMailWithAdminDelegate(
    mailbox: CloudflareTempMailboxCredentials,
    request: {
      toEmailAddress: string;
      toName?: string;
      subject: string;
      textBody?: string;
      htmlBody?: string;
      fromName?: string;
    },
  ): Promise<void> {
    if (!this.config.adminAuth?.trim()) {
      throw new Error("Cloudflare Temp Email adminAuth is not configured.");
    }

    const controller = new AbortController();
    const timeoutMs = Math.max(1000, this.config.timeoutSeconds * 1000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (fetch as unknown as (
        input: string,
        init?: Record<string, unknown>,
      ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>)(
        `${this.config.baseUrl.replace(/\/$/, "")}/admin/send_mail`,
        {
          method: "POST",
          headers: {
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            ...(this.config.customAuth ? { "x-custom-auth": this.config.customAuth } : {}),
            "x-admin-auth": this.config.adminAuth,
          },
          body: JSON.stringify({
            from_name: request.fromName?.trim() || "",
            from_mail: mailbox.address,
            to_mail: request.toEmailAddress,
            to_name: request.toName?.trim() || "",
            subject: request.subject,
            content: request.htmlBody?.trim() ? request.htmlBody : (request.textBody ?? ""),
            is_html: Boolean(request.htmlBody?.trim()),
          }),
          signal: controller.signal,
        },
      );
      const text = await response.text();
      if (response.status !== 200) {
        throw new Error(`Cloudflare Temp Email admin sendMail failed with status ${response.status}${text?.trim() ? `: ${text.trim()}` : "."}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Cloudflare Temp Email admin sendMail timed out after ${this.config.timeoutSeconds}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async sendMailboxMessage(
    mailbox: CloudflareTempMailboxCredentials,
    request: {
      toEmailAddress: string;
      toName?: string;
      subject: string;
      textBody?: string;
      htmlBody?: string;
      fromName?: string;
    },
  ): Promise<CloudflareTempEmailSendResult> {
    if (!request.toEmailAddress.trim()) {
      throw new Error("Cloudflare Temp Email sendMailboxMessage requires a recipient email address.");
    }
    if (!request.subject.trim()) {
      throw new Error("Cloudflare Temp Email sendMailboxMessage requires a subject.");
    }
    if (!request.textBody?.trim() && !request.htmlBody?.trim()) {
      throw new Error("Cloudflare Temp Email sendMailboxMessage requires textBody or htmlBody.");
    }

    try {
      await this.requestSendMailAccess(mailbox.jwt);
    } catch {
      // Best-effort only. Some deployments still rely on admin delegation or manual balance wiring.
    }

    try {
      await this.sendMailWithMailboxToken(mailbox, request);
      return { deliveryMode: "mailbox_token" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const shouldFallback = /no balance|failed to send mail|status 400|status 401|status 403/i.test(message);
      if (!shouldFallback || !this.config.adminAuth?.trim()) {
        throw error;
      }
    }

    await this.sendMailWithAdminDelegate(mailbox, request);
    return {
      deliveryMode: "admin_delegate",
      detail: "mailbox_token_fallback_to_admin",
    };
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: CloudflareTempMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const mails = (await this.listMails(mailbox.jwt)).sort((left, right) => {
      const leftId = typeof left.id === "number" ? left.id : 0;
      const rightId = typeof right.id === "number" ? right.id : 0;
      return rightId - leftId;
    });

    for (const mail of mails) {
      const sender = String(mail.source ?? mail.from ?? "").trim();
      if (fromContains && sender.toLowerCase().includes(fromContains.toLowerCase()) === false) {
        continue;
      }

      const subjectCode = extractOtpFromContent({
        sender,
        subject: mail.subject,
      });
      if (subjectCode) {
        const mailId = typeof mail.id === "number" ? mail.id : undefined;
        const detail = mailId ? await this.getMail(mailbox.jwt, mailId) : {};
        const raw = typeof detail.raw === "string" ? detail.raw : undefined;
        const parsedBodies = parseRawMailBodies(raw);
        return {
          id: `cloudflare_temp_email:${String(mail.id ?? `${sessionId}:subject`)}`,
          sessionId,
          providerInstanceId,
          observedAt: extractObservedAtFromRaw(raw),
          sender,
          subject: mail.subject,
          htmlBody: parsedBodies.htmlBody,
          textBody: parsedBodies.textBody,
          extractedCode: subjectCode.code,
          codeSource: subjectCode.source,
        };
      }

      const mailId = typeof mail.id === "number" ? mail.id : undefined;
      if (!mailId) {
        continue;
      }

      const detail = await this.getMail(mailbox.jwt, mailId);
      const raw = typeof detail.raw === "string" ? detail.raw : undefined;
      const parsedBodies = parseRawMailBodies(raw);
      let resolvedSubject = typeof mail.subject === "string" && mail.subject.trim()
        ? mail.subject.trim()
        : parseRawMailHeader(raw, "Subject");
      const fallbackRaw = !parsedBodies.textBody && !parsedBodies.htmlBody
        ? raw
        : undefined;
      let resolvedTextBody = parsedBodies.textBody;
      let resolvedHtmlBody = parsedBodies.htmlBody;
      let rawCode = extractOtpFromContent({
        sender,
        subject: resolvedSubject,
        htmlBody: resolvedHtmlBody ?? fallbackRaw,
        textBody: resolvedTextBody ?? fallbackRaw,
      });
      let parsedMailUsedForCode = false;
      if (!rawCode) {
        try {
          const parsedMail = await this.getParsedMail(mailbox.jwt, mailId);
          const parsedTextBody = typeof parsedMail.text === "string" ? parsedMail.text.trim() : "";
          const parsedHtmlBody = typeof parsedMail.html === "string" ? parsedMail.html.trim() : "";
          const parsedSubject = typeof parsedMail.subject === "string" ? parsedMail.subject.trim() : "";
          rawCode = extractOtpFromContent({
            sender: String(parsedMail.sender ?? sender).trim(),
            subject: typeof parsedMail.subject === "string" && parsedMail.subject.trim()
              ? parsedMail.subject
              : (typeof mail.subject === "string" ? mail.subject : undefined),
            htmlBody: parsedHtmlBody || undefined,
            textBody: parsedTextBody || undefined,
          });
          parsedMailUsedForCode = Boolean(rawCode);
          if (parsedSubject) {
            resolvedSubject = parsedSubject;
          }
          if (parsedTextBody && (!resolvedTextBody || parsedMailUsedForCode)) {
            resolvedTextBody = parsedTextBody;
          }
          if (parsedHtmlBody && (!resolvedHtmlBody || parsedMailUsedForCode)) {
            resolvedHtmlBody = parsedHtmlBody;
          }
        } catch {
          // Some deployments do not expose /api/parsed_mail; keep the raw-mail fallback only.
        }
      }
      if (!rawCode) {
        continue;
      }
      return {
        id: `cloudflare_temp_email:${mailId}`,
        sessionId,
        providerInstanceId,
        observedAt: extractObservedAtFromRaw(raw),
        sender,
        subject: resolvedSubject,
        htmlBody: resolvedHtmlBody,
        textBody: resolvedTextBody,
        extractedCode: rawCode.code,
        codeSource: rawCode.source,
      };
    }

    return undefined;
  }
}

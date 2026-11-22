import type { MailAccountRepository } from "../domain/account.js";
import { EasyEmailError } from "../domain/errors.js";
import type {
  EasyEmailClientSettings,
  EasyEmailClientSettingsUpdateInput,
  EasyEmailConnectionHealth,
  EasyEmailConnectionTestInput,
  MailExtensionsRepository,
  MailNewsletterSubscription,
  MailNewsletterSubscriptionActionResult,
  MailNewsletterSubscriptionListQuery,
  MailNewsletterSubscriptionUpdateInput,
} from "../domain/mail-extensions.js";
import type { EasyEmailService } from "./easy-email-service.js";

const EASYEMAIL_SERVICE_URL_KEY = "easyemail.service_url";
const CONNECTION_TEST_TIMEOUT_MS = 5_000;

export interface MailExtensionsServiceDependencies {
  accountRepository?: MailAccountRepository;
  easyEmailService?: EasyEmailService;
  runtimeHasApiKey?: boolean;
  fetchImpl?: typeof fetch;
}

function normalizeEasyEmailServiceUrl(rawUrl: unknown, allowEmpty = false): string | null {
  if (rawUrl === null || rawUrl === undefined) {
    if (allowEmpty) return null;
    throw new EasyEmailError("INVALID_SETTINGS", "serviceUrl is required.");
  }
  if (typeof rawUrl !== "string") {
    throw new EasyEmailError("INVALID_SETTINGS", "serviceUrl must be a string.");
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    if (allowEmpty) return null;
    throw new EasyEmailError("INVALID_SETTINGS", "EasyEmail service URL cannot be empty.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new EasyEmailError("INVALID_SETTINGS", "EasyEmail service URL is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EasyEmailError(
      "INVALID_SETTINGS",
      "EasyEmail service URL must use http:// or https://.",
    );
  }
  if (parsed.username || parsed.password) {
    throw new EasyEmailError(
      "INVALID_SETTINGS",
      "EasyEmail service URL must not embed credentials.",
    );
  }
  return trimmed.replace(/\/+$/u, "");
}

export class MailExtensionsService {
  public constructor(
    private readonly repository: MailExtensionsRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly dependencies: MailExtensionsServiceDependencies = {},
  ) {}

  public async listNewsletterSubscriptions(
    query: MailNewsletterSubscriptionListQuery,
  ): Promise<MailNewsletterSubscription[]> {
    const accountId = typeof query?.accountId === "string" ? query.accountId.trim() : "";
    if (!accountId) {
      throw new EasyEmailError("INVALID_QUERY", "accountId is required.");
    }
    if (this.dependencies.accountRepository) {
      const account = await this.dependencies.accountRepository.getMailAccount(accountId);
      if (!account) {
        throw new EasyEmailError("ACCOUNT_NOT_FOUND", `Account ${accountId} was not found.`);
      }
    }
    return this.repository.listNewsletterSubscriptions(accountId);
  }

  public async setNewsletterSubscriptionHidden(
    rawSubscriptionId: string,
    input: MailNewsletterSubscriptionUpdateInput,
  ): Promise<MailNewsletterSubscriptionActionResult> {
    const subscriptionId = rawSubscriptionId.trim();
    if (!subscriptionId) {
      throw new EasyEmailError("INVALID_QUERY", "subscriptionId is required.");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_REQUEST", "Request body must be a JSON object.");
    }
    const accountId = typeof input.accountId === "string" ? input.accountId.trim() : "";
    if (!accountId) {
      throw new EasyEmailError("INVALID_REQUEST", "accountId is required.");
    }
    if (typeof input.hidden !== "boolean") {
      throw new EasyEmailError("INVALID_REQUEST", "hidden must be a boolean.");
    }
    if (this.dependencies.accountRepository) {
      const account = await this.dependencies.accountRepository.getMailAccount(accountId);
      if (!account) {
        throw new EasyEmailError("ACCOUNT_NOT_FOUND", `Account ${accountId} was not found.`);
      }
    }

    const changed = await this.repository.setNewsletterSubscriptionHidden(
      accountId,
      subscriptionId,
      input.hidden,
      this.now().toISOString(),
    );
    return {
      accountId,
      subscriptionId,
      hidden: input.hidden,
      changed,
    };
  }

  public async getEasyEmailSettings(): Promise<EasyEmailClientSettings> {
    const storedUrl = await this.repository.getClientSetting(EASYEMAIL_SERVICE_URL_KEY);
    return {
      serviceUrl: storedUrl ?? null,
      hasApiToken: Boolean(this.dependencies.runtimeHasApiKey),
    };
  }

  public async updateEasyEmailSettings(
    input: EasyEmailClientSettingsUpdateInput,
  ): Promise<EasyEmailClientSettings> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_SETTINGS", "Settings update body must be a JSON object.");
    }
    if ("apiToken" in (input as unknown as Record<string, unknown>)) {
      throw new EasyEmailError(
        "SETTINGS_SECRET_FORBIDDEN",
        "API tokens must not be persisted in EasyEmail settings.",
      );
    }
    const normalizedUrl = normalizeEasyEmailServiceUrl(input.serviceUrl, false);
    await this.repository.setClientSetting(
      EASYEMAIL_SERVICE_URL_KEY,
      normalizedUrl,
      this.now().toISOString(),
    );
    return {
      serviceUrl: normalizedUrl,
      hasApiToken: false,
    };
  }

  public async testEasyEmailConnection(
    input: EasyEmailConnectionTestInput = {},
  ): Promise<EasyEmailConnectionHealth> {
    if (input !== null && typeof input !== "object") {
      throw new EasyEmailError("INVALID_SETTINGS", "Connection test body must be a JSON object.");
    }
    const requestedUrl = normalizeEasyEmailServiceUrl(input?.serviceUrl, true);
    const storedUrl = await this.repository.getClientSetting(EASYEMAIL_SERVICE_URL_KEY);
    const targetUrl = requestedUrl ?? storedUrl ?? null;
    const token = typeof input?.apiToken === "string" && input.apiToken.trim()
      ? input.apiToken.trim()
      : undefined;

    if (!targetUrl) {
      const catalog = this.dependencies.easyEmailService?.getCatalog();
      const providerCount = catalog?.providerTypes.length ?? 0;
      return {
        reachable: true,
        providerCount,
        authStatus: this.dependencies.runtimeHasApiKey || token ? "configured" : "anonymous",
        capabilitiesSummary: "temporary mail, verification, and IMAP/SMTP",
      };
    }

    const fetchFn = this.dependencies.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECTION_TEST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (token) {
        headers.authorization = `Bearer ${token}`;
      }
      const response = await fetchFn(`${targetUrl}/mail/catalog`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new EasyEmailError(
          "EASYEMAIL_AUTH_FAILED",
          "Target EasyEmail service rejected authentication.",
        );
      }
      if (!response.ok) {
        throw new EasyEmailError(
          "EASYEMAIL_UNREACHABLE",
          `Target EasyEmail service returned HTTP ${response.status}.`,
        );
      }
      const payload = (await response.json()) as {
        catalog?: { providerTypes?: unknown[] };
      };
      const providerCount = Array.isArray(payload?.catalog?.providerTypes)
        ? payload.catalog.providerTypes.length
        : 0;
      return {
        reachable: true,
        providerCount,
        authStatus: token ? "authenticated" : "anonymous",
        capabilitiesSummary: "temporary mail and verification",
      };
    } catch (error) {
      if (error instanceof EasyEmailError) {
        throw error;
      }
      throw new EasyEmailError(
        "EASYEMAIL_UNREACHABLE",
        "Could not reach the configured EasyEmail service URL.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createMailExtensionsService(
  repository: MailExtensionsRepository,
  now?: () => Date,
  dependencies?: MailExtensionsServiceDependencies,
): MailExtensionsService {
  return new MailExtensionsService(repository, now, dependencies);
}

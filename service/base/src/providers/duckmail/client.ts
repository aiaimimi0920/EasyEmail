import type { ObservedMessage, ProviderInstance } from "../../domain/models.js";
import {
  asRecord,
  asRecordList,
  buildDuckMailStatusError,
  classifyDuckMailProbeError,
  createAlphaNumeric,
  createPassword,
  encodeQuery,
  extractOtp,
  matchesSenderFilter,
  nextDomainRotationOffset,
  normalizeDomain,
  normalizeFromContains,
  parseOptionalInteger,
  readHydraPagePointers,
  readMetadata,
  readSender,
  readStringLike,
  requestJson,
  sanitizeLocalPart,
} from "./support.js";

export interface DuckMailConfig {
  apiBase: string;
  preferredDomain?: string;
  apiKey?: string;
  expiresIn?: number;
  passwordLength: number;
}

export interface DuckMailMailboxCredentials {
  email: string;
  token: string;
  password: string;
  accountId: string;
}

export function resolveDuckMailConfig(instance: ProviderInstance): DuckMailConfig {
  return {
    apiBase: readMetadata(instance, "apiBase") ?? "https://api.duckmail.sbs",
    preferredDomain: readMetadata(instance, "domain"),
    apiKey: readMetadata(instance, "apiKey"),
    expiresIn: parseOptionalInteger(readMetadata(instance, "expiresIn")),
    passwordLength: parseOptionalInteger(readMetadata(instance, "passwordLength")) ?? 12,
  };
}

export function encodeDuckMailMailboxRef(instanceId: string, mailbox: DuckMailMailboxCredentials): string {
  return `duckmail:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeDuckMailMailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): DuckMailMailboxCredentials | undefined {
  const normalizedRef = mailboxRef.trim();
  const normalizedInstanceId = expectedInstanceId.trim();
  if (!normalizedRef || !normalizedInstanceId) {
    return undefined;
  }

  const prefix = `duckmail:${normalizedInstanceId}:`;
  if (!normalizedRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(normalizedRef.slice(prefix.length))) as Record<string, unknown>;
    const email = readStringLike(payload.email) ?? "";
    const token = readStringLike(payload.token) ?? "";
    const password = readStringLike(payload.password) ?? "";
    const accountId = readStringLike(payload.accountId) ?? "";
    if (!email || !token || !password || !accountId || !email.includes("@")) {
      return undefined;
    }
    return {
      email: email.trim().toLowerCase(),
      token: token.trim(),
      password: password.trim(),
      accountId: accountId.trim(),
    };
  } catch {
    return undefined;
  }
}

export class DuckMailClient {
  public constructor(private readonly config: DuckMailConfig) {}

  public static fromInstance(instance: ProviderInstance): DuckMailClient {
    return new DuckMailClient(resolveDuckMailConfig(instance));
  }

  public async getDomains(): Promise<string[]> {
    const domains = new Set<string>();
    let page = 1;
    let lastPage = 1;

    while (page <= lastPage && page <= 5) {
      const response = await requestJson(
        this.config,
        "GET",
        `/domains${encodeQuery({ page })}`,
        { apiKey: this.config.apiKey },
      );
      if (response.status !== 200) {
        throw buildDuckMailStatusError("getDomains", response.status, response.body);
      }

      const body = response.body;
      const items = Array.isArray(body)
        ? body
        : asRecordList(asRecord(body)["hydra:member"] ?? asRecord(body).items ?? asRecord(body).domains);
      for (const item of items) {
        const domain = readStringLike(item.domain ?? item.name)?.toLowerCase();
        const verified = item.verified ?? item.isVerified ?? true;
        if (domain && verified !== false) {
          domains.add(domain);
        }
      }

      const pagePointers = readHydraPagePointers(body);
      lastPage = Math.max(page, pagePointers.lastPage ?? page);
      page += 1;
    }

    return [...domains];
  }

  public async createMailbox(options: { suggestedLocalPart?: string; maxRetries?: number } = {}): Promise<DuckMailMailboxCredentials> {
    const preferredDomain = normalizeDomain(this.config.preferredDomain);
    const domains = await this.getDomains();
    const eligibleDomains = preferredDomain
      ? [preferredDomain, ...domains.filter((item) => item !== preferredDomain)]
      : domains;
    if (eligibleDomains.length === 0) {
      throw new Error("DuckMail returned no available domains.");
    }

    const baseLocalPart = sanitizeLocalPart(options.suggestedLocalPart);
    const maxRetries = options.maxRetries ?? 5;
    const rotationOffset = preferredDomain
      ? 0
      : nextDomainRotationOffset(this.config.apiBase.trim().toLowerCase(), eligibleDomains);

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const localPart = `${baseLocalPart}-${createAlphaNumeric(4).toLowerCase()}`.slice(0, 60);
      const domain = eligibleDomains[(rotationOffset + attempt) % eligibleDomains.length]!;
      const email = `${localPart}@${domain}`;
      const password = createPassword(this.config.passwordLength);

      const createResponse = await requestJson(this.config, "POST", "/accounts", {
        apiKey: this.config.apiKey,
        jsonBody: {
          address: email,
          password,
          ...(this.config.expiresIn ? { expiresIn: this.config.expiresIn } : {}),
        },
      });

      if (createResponse.status !== 200 && createResponse.status !== 201) {
        if ([400, 409, 422].includes(createResponse.status) && attempt < maxRetries - 1) {
          continue;
        }
        throw buildDuckMailStatusError("createAccount", createResponse.status, createResponse.body);
      }

      const account = asRecord(createResponse.body);
      const resolvedEmail = readStringLike(account.address) ?? email;
      const accountId = readStringLike(account.id ?? account.account_id) ?? "";

      const token = await this.getToken(resolvedEmail, password);
      if (!token || !accountId) {
        throw new Error("DuckMail createMailbox returned an incomplete account payload.");
      }

      return {
        email: resolvedEmail,
        token,
        password,
        accountId,
      };
    }

    throw new Error("DuckMail createMailbox exhausted retries.");
  }

  public async getToken(email: string, password: string): Promise<string> {
    const tokenResponse = await requestJson(this.config, "POST", "/token", {
      jsonBody: {
        address: email.trim().toLowerCase(),
        password,
      },
    });
    if (tokenResponse.status !== 200) {
      throw buildDuckMailStatusError("getToken", tokenResponse.status, tokenResponse.body);
    }

    const token = readStringLike(asRecord(tokenResponse.body).token) ?? "";
    if (!token) {
      throw new Error("DuckMail getToken returned an empty token.");
    }
    return token;
  }

  public async listMessages(token: string): Promise<Record<string, unknown>[]> {
    const messages: Record<string, unknown>[] = [];
    let page = 1;
    let lastPage = 1;

    while (page <= lastPage && page <= 3) {
      const response = await requestJson(this.config, "GET", `/messages${encodeQuery({ page })}`, { token });
      if (response.status !== 200) {
        throw buildDuckMailStatusError("listMessages", response.status, response.body);
      }

      const body = response.body;
      const items = Array.isArray(body)
        ? body.filter((item) => item && typeof item === "object") as Record<string, unknown>[]
        : asRecordList(asRecord(body)["hydra:member"] ?? asRecord(body).items ?? asRecord(body).messages);
      messages.push(...items);

      const pagePointers = readHydraPagePointers(body);
      lastPage = Math.max(page, pagePointers.lastPage ?? page);
      page += 1;
    }

    return messages;
  }

  public async getMessage(token: string, messageId: string): Promise<Record<string, unknown>> {
    const response = await requestJson(
      this.config,
      "GET",
      `/messages/${encodeURIComponent(messageId)}`,
      { token },
    );
    if (response.status === 404) {
      return {};
    }
    if (response.status !== 200) {
      throw buildDuckMailStatusError("getMessage", response.status, response.body);
    }

    return asRecord(response.body);
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: DuckMailMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const messages = await this.listMessages(mailbox.token);
    const fromContainsNormalized = normalizeFromContains(fromContains);

    for (const item of messages) {
      const messageId = readStringLike(item.id ?? item["@id"]);
      if (!messageId) {
        continue;
      }

      const sender = readSender(item.from);
      if (!matchesSenderFilter(sender, fromContainsNormalized)) {
        continue;
      }

      const summarySubject = readStringLike(item.subject);
      const summaryIntro = readStringLike(item.intro ?? item.snippet ?? item.bodyPreview);
      const summaryOtp = extractOtp({
        subject: summarySubject,
        textBody: summaryIntro,
      });
      if (summaryOtp) {
        return {
          id: `duckmail:${messageId}`,
          sessionId,
          providerInstanceId,
          observedAt: readStringLike(item.createdAt) ?? "",
          sender,
          subject: summarySubject,
          textBody: summaryIntro,
          extractedCode: summaryOtp.code,
          codeSource: summaryOtp.source,
        };
      }

      const detail = await this.getMessage(mailbox.token, messageId);
      const detailSender = readSender(detail.from) ?? sender;
      if (!matchesSenderFilter(detailSender, fromContainsNormalized)) {
        continue;
      }

      const detailSubject = readStringLike(detail.subject) ?? summarySubject;
      const textBody = readStringLike(detail.text ?? detail.body);
      const htmlBody = readStringLike(detail.html);
      const detailOtp = extractOtp({
        subject: detailSubject,
        textBody,
        htmlBody,
      });
      return {
        id: `duckmail:${messageId}`,
        sessionId,
        providerInstanceId,
        observedAt: readStringLike(detail.createdAt) ?? "",
        sender: detailSender,
        subject: detailSubject,
        textBody,
        htmlBody,
        extractedCode: detailOtp?.code,
        codeSource: detailOtp?.source,
      };
    }

    return undefined;
  }
}

export async function probeDuckMailInstance(instance: ProviderInstance): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
}> {
  const client = DuckMailClient.fromInstance(instance);
  const startedAt = Date.now();
  try {
    const domains = await client.getDomains();
    return {
      ok: domains.length > 0,
      detail: domains.length > 0
        ? `DUCKMAIL_PROBE_OK: DuckMail returned ${domains.length} available domains.`
        : "DUCKMAIL_MAILBOX_DELIVERY_FAILURE: DuckMail returned no available domains.",
      averageLatencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      detail: classifyDuckMailProbeError(error),
      averageLatencyMs: Date.now() - startedAt,
    };
  }
}

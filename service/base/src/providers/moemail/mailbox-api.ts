import { buildStatusError, classifyThrownError } from "./failure.js";
import { requestJson } from "./http.js";
import {
  asRecord,
  extractMailboxListingEntries,
  extractMailboxPayload,
  extractMessageEntries,
  splitEmailAddress,
  summarizeMessage,
} from "./payload.js";
import {
  MoemailClientError,
  type MoemailConfig,
  type MoemailMailboxAccessCheckResult,
  type MoemailMailboxCredentials,
  type MoemailMailboxListingEntry,
  type MoemailMessageSummary,
} from "./types.js";

export class MoemailMailboxApi {
  public constructor(private readonly config: MoemailConfig) {}

  public async listEmails(
    apiKey: string,
    cursor?: string,
  ): Promise<{ emails: MoemailMailboxListingEntry[]; nextCursor?: string; total?: number }> {
    const response = await requestJson(
      this.config,
      apiKey,
      "GET",
      "/api/emails",
      { cursor },
    );

    if (response.status !== 200) {
      throw buildStatusError("listEmails", response.status, response.body);
    }

    return extractMailboxListingEntries(response.body);
  }

  public async listMailboxMessages(
    apiKey: string,
    emailId: string,
    cursor?: string,
  ): Promise<{ items: MoemailMessageSummary[]; nextCursor?: string }> {
    const response = await requestJson(
      this.config,
      apiKey,
      "GET",
      `/api/emails/${encodeURIComponent(emailId)}`,
      { cursor },
    );

    if (response.status === 404) {
      return { items: [] };
    }
    if (response.status !== 200) {
      throw buildStatusError("listMailboxMessages", response.status, response.body);
    }

    const extracted = extractMessageEntries(response.body);
    return {
      items: extracted.items
        .map((item) => summarizeMessage(item))
        .filter((item): item is MoemailMessageSummary => item !== undefined),
      nextCursor: extracted.nextCursor,
    };
  }

  public async findMailboxByEmailAddress(
    apiKey: string,
    emailAddress: string,
    maxPages = 50,
  ): Promise<MoemailMailboxCredentials | undefined> {
    const identity = splitEmailAddress(emailAddress);
    if (!identity) {
      return undefined;
    }

    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await this.listEmails(apiKey, cursor);
      for (const entry of page.emails) {
        if (entry.email.trim().toLowerCase() !== identity.email) {
          continue;
        }
        return {
          emailId: entry.emailId,
          email: entry.email,
          localPart: identity.localPart,
          domain: identity.domain,
        };
      }
      cursor = page.nextCursor?.trim() || undefined;
      if (!cursor) {
        break;
      }
    }

    return undefined;
  }

  public async inspectMailboxAccess(
    apiKey: string,
    mailbox: MoemailMailboxCredentials,
  ): Promise<MoemailMailboxAccessCheckResult> {
    try {
      const response = await requestJson(
        this.config,
        apiKey,
        "GET",
        `/api/emails/${encodeURIComponent(mailbox.emailId)}`,
      );

      if (response.status >= 200 && response.status < 300) {
        return { status: "accessible" };
      }
      if (response.status === 404) {
        return { status: "missing" };
      }
      return {
        status: classifyThrownError(
          buildStatusError("inspectMailboxAccess", response.status, response.body),
        ).kind,
      };
    } catch (error) {
      return { status: classifyThrownError(error).kind };
    }
  }

  public async generateMailbox(
    apiKey: string,
    options: { localPart: string; expiryTime?: number; domain?: string },
  ): Promise<MoemailMailboxCredentials> {
    const response = await requestJson(this.config, apiKey, "POST", "/api/emails/generate", {
      jsonBody: {
        name: options.localPart,
        expiryTime: options.expiryTime ?? this.config.expiryTimeMs,
        ...(options.domain ? { domain: options.domain } : {}),
      },
    });

    if (response.status !== 200 && response.status !== 201) {
      throw buildStatusError("generateMailbox", response.status, response.body);
    }

    const mailbox = extractMailboxPayload(response.body, options.localPart, options.domain);
    if (!mailbox) {
      throw new MoemailClientError(
        "MoEmail generate mailbox returned an incomplete mailbox payload.",
        "provider",
      );
    }
    return mailbox;
  }

  public async deleteMailbox(
    apiKey: string,
    emailId: string,
    useCase: "generate" | "poll" = "poll",
  ): Promise<{ released: boolean; detail: string }> {
    const response = await requestJson(
      this.config,
      apiKey,
      "DELETE",
      `/api/emails/${encodeURIComponent(emailId)}`,
    );

    if (response.status === 404) {
      return { released: false, detail: "already_deleted" };
    }
    if (response.status !== 200 && response.status !== 204) {
      throw buildStatusError(`deleteMailbox:${useCase}`, response.status, response.body);
    }
    return { released: true, detail: "deleted" };
  }

  public async getMailboxMessage(
    apiKey: string,
    mailbox: MoemailMailboxCredentials,
    messageId: string,
  ): Promise<Record<string, unknown>> {
    const response = await requestJson(
      this.config,
      apiKey,
      "GET",
      `/api/emails/${encodeURIComponent(mailbox.emailId)}/${encodeURIComponent(messageId)}`,
    );

    if (response.status === 404) {
      return {};
    }
    if (response.status !== 200) {
      throw buildStatusError("getMailboxMessage", response.status, response.body);
    }
    return asRecord(response.body);
  }
}

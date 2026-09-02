import { ImapFlow, type ImapFlowOptions } from "imapflow";

import type { MailAccountImapProfile } from "../domain/account.js";
import { EasyEmailError } from "../domain/errors.js";
import type {
  MailImapConnectionTester,
  MailImapConnectionTestResult,
} from "./account-connectivity.js";

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

interface ImapFlowClient {
  capabilities: Map<string, boolean | number>;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
}

export type ImapFlowClientFactory = (options: ImapFlowOptions) => ImapFlowClient;

export interface ImapFlowConnectionTesterOptions {
  connectionTimeoutMs?: number;
  createClient?: ImapFlowClientFactory;
}

function isAuthenticationFailure(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as { authenticationFailed?: unknown }).authenticationFailed === true,
  );
}

async function logoutWithin(client: ImapFlowClient, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.logout(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("IMAP logout timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class ImapFlowConnectionTester implements MailImapConnectionTester {
  private readonly connectionTimeoutMs: number;
  private readonly createClient: ImapFlowClientFactory;

  public constructor(options: ImapFlowConnectionTesterOptions = {}) {
    const timeout = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000) {
      throw new Error("IMAP connection timeout must be an integer from 100 to 60000 milliseconds.");
    }
    this.connectionTimeoutMs = timeout;
    this.createClient = options.createClient ?? ((clientOptions) => new ImapFlow(clientOptions));
  }

  public async testConnection(
    profile: MailAccountImapProfile,
    secret: string,
  ): Promise<MailImapConnectionTestResult> {
    const client = this.createClient({
      host: profile.host,
      port: profile.port,
      secure: profile.security === "tls",
      doSTARTTLS: profile.security === "starttls" ? true : undefined,
      auth: { user: profile.username, pass: secret },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: this.connectionTimeoutMs,
      greetingTimeout: this.connectionTimeoutMs,
      socketTimeout: this.connectionTimeoutMs,
      tls: { minVersion: "TLSv1.2" },
    });
    let connected = false;
    try {
      await client.connect();
      connected = true;
      const capabilities = [...client.capabilities.keys()]
        .map((value) => value.trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
      return {
        authenticated: true,
        capabilitySummary: capabilities.length > 0
          ? capabilities.join(" ")
          : "IMAP authenticated",
      };
    } catch (error) {
      if (isAuthenticationFailure(error)) {
        throw new EasyEmailError("IMAP_AUTH_FAILED", "The IMAP server rejected the account credential.");
      }
      throw error;
    } finally {
      if (connected) {
        try {
          await logoutWithin(client, this.connectionTimeoutMs);
        } catch {
          client.close();
        }
      } else {
        client.close();
      }
    }
  }
}

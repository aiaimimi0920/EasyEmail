import type { MailCredentialResolver } from "../service/account-connectivity.js";

export const DESKTOP_CREDENTIAL_BROKER_URL_ENV = "EASY_EMAIL_DESKTOP_CREDENTIAL_BROKER_URL";
export const DESKTOP_CREDENTIAL_BROKER_TOKEN_ENV = "EASY_EMAIL_DESKTOP_CREDENTIAL_BROKER_TOKEN";

const BROKER_RESOLVE_PATH = "/v1/credentials/resolve";
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_LENGTH = 16_384;

export interface DesktopCredentialBrokerResolverOptions {
  baseUrl: string;
  bearerToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function resolveBrokerEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || (url.pathname !== "/" && url.pathname !== "")
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("Desktop credential broker must be an authenticated 127.0.0.1 HTTP endpoint.");
  }
  url.pathname = BROKER_RESOLVE_PATH;
  return url.toString();
}

export class DesktopCredentialBrokerResolver implements MailCredentialResolver {
  private readonly endpoint: string;
  private readonly bearerToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: DesktopCredentialBrokerResolverOptions) {
    this.endpoint = resolveBrokerEndpoint(options.baseUrl);
    if (typeof options.bearerToken !== "string" || options.bearerToken.length < 32) {
      throw new Error("Desktop credential broker token must contain at least 32 characters.");
    }
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) {
      throw new Error("Desktop credential broker timeout must be an integer from 100 to 30000 milliseconds.");
    }
    this.bearerToken = options.bearerToken;
    this.timeoutMs = timeout;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async resolveCredential(request: Parameters<MailCredentialResolver["resolveCredential"]>[0]) {
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          authorization: `Bearer ${this.bearerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accountId: request.account.id,
          credentialRefId: request.credentialRef.id,
          secretBackend: request.credentialRef.secretBackend,
          secretKey: request.credentialRef.secretKey,
          credentialKind: request.credentialRef.credentialKind,
          authMethod: request.credentialRef.authMethod,
          useCase: request.useCase,
        }),
      });
      if (response.status === 404) return { status: "missing" } as const;
      if (!response.ok) return { status: "unavailable" } as const;
      const body = await response.text();
      if (body.length > MAX_RESPONSE_LENGTH) return { status: "unavailable" } as const;
      const parsed = JSON.parse(body) as unknown;
      if (
        !parsed
        || typeof parsed !== "object"
        || (parsed as { status?: unknown }).status !== "resolved"
        || typeof (parsed as { secret?: unknown }).secret !== "string"
        || !(parsed as { secret: string }).secret
      ) {
        return { status: "unavailable" } as const;
      }
      return { status: "resolved", secret: (parsed as { secret: string }).secret } as const;
    } catch {
      return { status: "unavailable" } as const;
    }
  }
}

export function createDesktopCredentialBrokerResolverFromEnvironment(
  environment: NodeJS.ProcessEnv,
): DesktopCredentialBrokerResolver | undefined {
  const baseUrl = environment[DESKTOP_CREDENTIAL_BROKER_URL_ENV]?.trim();
  const bearerToken = environment[DESKTOP_CREDENTIAL_BROKER_TOKEN_ENV]?.trim();
  if (!baseUrl && !bearerToken) return undefined;
  if (!baseUrl || !bearerToken) {
    throw new Error("Desktop credential broker URL and token must be configured together.");
  }
  return new DesktopCredentialBrokerResolver({ baseUrl, bearerToken });
}

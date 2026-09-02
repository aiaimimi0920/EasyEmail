import { describe, expect, it } from "vitest";

import type { MailAccount, MailCredentialRef } from "../../src/domain/account.js";
import {
  createDesktopCredentialBrokerResolverFromEnvironment,
  DESKTOP_CREDENTIAL_BROKER_TOKEN_ENV,
  DESKTOP_CREDENTIAL_BROKER_URL_ENV,
  DesktopCredentialBrokerResolver,
} from "../../src/runtime/desktop-credential-broker.js";

const ACCOUNT = { id: "acct_v1_test" } as MailAccount;
const CREDENTIAL_REF = {
  id: "cred_v1_test",
  ownerAccountId: ACCOUNT.id,
  secretBackend: "windows_credential_manager",
  secretKey: "ref:v1:desktop/test",
  credentialKind: "imap_password",
  authMethod: "password",
} as MailCredentialRef;
const TOKEN = "desktop-broker-test-token-00000000000000000000000000000000";

describe("DesktopCredentialBrokerResolver", () => {
  it("sends only scoped reference metadata with a private token and resolves the response", async () => {
    const requests: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = [];
    const resolver = new DesktopCredentialBrokerResolver({
      baseUrl: "http://127.0.0.1:32123",
      bearerToken: TOKEN,
      async fetchImpl(input, init) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ url: String(input), init, body });
        return new Response(JSON.stringify({ status: "resolved", secret: "broker-secret-canary" }));
      },
    });

    await expect(resolver.resolveCredential({
      account: ACCOUNT,
      credentialRef: CREDENTIAL_REF,
      useCase: "imap-test",
    })).resolves.toEqual({ status: "resolved", secret: "broker-secret-canary" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://127.0.0.1:32123/v1/credentials/resolve");
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(requests[0]?.body).toEqual({
      accountId: ACCOUNT.id,
      credentialRefId: CREDENTIAL_REF.id,
      secretBackend: CREDENTIAL_REF.secretBackend,
      secretKey: CREDENTIAL_REF.secretKey,
      credentialKind: "imap_password",
      authMethod: "password",
      useCase: "imap-test",
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain("broker-secret-canary");
  });

  it("maps missing and malformed broker responses without exposing transport failures", async () => {
    const missing = new DesktopCredentialBrokerResolver({
      baseUrl: "http://127.0.0.1:32123",
      bearerToken: TOKEN,
      fetchImpl: async () => new Response("", { status: 404 }),
    });
    await expect(missing.resolveCredential({
      account: ACCOUNT,
      credentialRef: CREDENTIAL_REF,
      useCase: "imap-test",
    })).resolves.toEqual({ status: "missing" });

    const unavailable = new DesktopCredentialBrokerResolver({
      baseUrl: "http://127.0.0.1:32123",
      bearerToken: TOKEN,
      fetchImpl: async () => new Response("not-json"),
    });
    await expect(unavailable.resolveCredential({
      account: ACCOUNT,
      credentialRef: CREDENTIAL_REF,
      useCase: "imap-test",
    })).resolves.toEqual({ status: "unavailable" });
  });

  it("accepts only complete authenticated loopback configuration", () => {
    expect(() => new DesktopCredentialBrokerResolver({
      baseUrl: "http://localhost:32123",
      bearerToken: TOKEN,
    })).toThrow("127.0.0.1");
    expect(() => new DesktopCredentialBrokerResolver({
      baseUrl: "http://127.0.0.1:32123",
      bearerToken: "short",
    })).toThrow("at least 32");
    expect(createDesktopCredentialBrokerResolverFromEnvironment({})).toBeUndefined();
    expect(() => createDesktopCredentialBrokerResolverFromEnvironment({
      [DESKTOP_CREDENTIAL_BROKER_URL_ENV]: "http://127.0.0.1:32123",
    })).toThrow("configured together");
    expect(createDesktopCredentialBrokerResolverFromEnvironment({
      [DESKTOP_CREDENTIAL_BROKER_URL_ENV]: "http://127.0.0.1:32123",
      [DESKTOP_CREDENTIAL_BROKER_TOKEN_ENV]: TOKEN,
    })).toBeInstanceOf(DesktopCredentialBrokerResolver);
  });
});

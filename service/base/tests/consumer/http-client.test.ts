import { describe, expect, it, vi } from "vitest";

import { HttpVerificationInboxClient, type JsonHttpClient } from "../../src/consumer/http-client.js";
import {
  EASY_EMAIL_HTTP_ROUTES,
  type RecoverMailboxByEmailHttpResponse,
} from "../../src/http/contracts.js";

describe("HttpVerificationInboxClient", () => {
  it("posts recover-by-email requests through the public recovery route", async () => {
    const response: RecoverMailboxByEmailHttpResponse = {
      result: {
        recovered: true,
        strategy: "session_restore",
        providerTypeKey: "cloudflare_temp_email",
        providerInstanceId: "cloudflare_temp_email_shared_default",
        session: {
          id: "mailbox_recovered",
          hostId: "python-register-orchestration",
          providerTypeKey: "cloudflare_temp_email",
          providerInstanceId: "cloudflare_temp_email_shared_default",
          emailAddress: "seed@example.com",
          mailboxRef: "cloudflare_temp_email:recovered-ref",
          status: "open",
          createdAt: "2026-06-17T00:00:00.000Z",
          metadata: {},
        },
        recoveryDataCredential: {
          emailAddress: "seed@example.com",
          providerTypeKey: "cloudflare_temp_email",
        },
      },
    };
    const postCalls: Array<{ path: string; body: unknown }> = [];
    const httpClient: JsonHttpClient = {
      get: vi.fn(async () => {
        throw new Error("unexpected get");
      }),
      post: async <TRequest, TResponse>(path: string, body: TRequest): Promise<TResponse> => {
        postCalls.push({ path, body });
        return response as TResponse;
      },
    };
    const client = new HttpVerificationInboxClient(httpClient);

    const result = await client.recoverMailboxByEmail({
      emailAddress: "seed@example.com",
      providerTypeKey: "cloudflare_temp_email",
      recoveryDataCredential: {
        emailAddress: "seed@example.com",
        providerTypeKey: "cloudflare_temp_email",
      },
    });

    expect(postCalls).toEqual([
      {
        path: EASY_EMAIL_HTTP_ROUTES.recoverMailboxByEmail,
        body: {
          emailAddress: "seed@example.com",
          providerTypeKey: "cloudflare_temp_email",
          recoveryDataCredential: {
            emailAddress: "seed@example.com",
            providerTypeKey: "cloudflare_temp_email",
          },
        },
      },
    ]);
    expect(result.recovered).toBe(true);
    expect(result.session?.mailboxRef).toBe("cloudflare_temp_email:recovered-ref");
    expect(result.recoveryDataCredential).toEqual({
      emailAddress: "seed@example.com",
      providerTypeKey: "cloudflare_temp_email",
    });
  });
});

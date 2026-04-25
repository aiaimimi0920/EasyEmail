import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createMailAliasService } from "../../src/alias/service.js";
import type { MailAliasProvider } from "../../src/alias/providers/contracts.js";
import { createDdgMailAliasProvider } from "../../src/alias/providers/ddg-provider.js";

function createDdgService(options: Parameters<typeof createDdgMailAliasProvider>[0]) {
  return createMailAliasService({
    providers: [createDdgMailAliasProvider(options)],
  });
}

describe("mail alias service", () => {
  it("returns not_requested when caller did not ask for alias email", async () => {
    const service = createDdgService({
      enabled: true,
      tokens: ["token"],
    });

    expect(service.planAlias({
      hostId: "demo",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    })).toEqual({
      requested: false,
      status: "not_requested",
    });

    await expect(service.createAliasOutcome({
      hostId: "demo",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    })).resolves.toEqual({
      requested: false,
      status: "not_requested",
    });
  });

  it("skips alias creation when the service feature is disabled", async () => {
    const service = createDdgService({
      enabled: false,
      tokens: ["token"],
    });

    await expect(service.createAliasOutcome({
      hostId: "demo",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
    })).resolves.toEqual({
      requested: true,
      status: "skipped_disabled",
      providerKey: "ddg",
    });
  });

  it("fails alias planning when DDG token is missing", async () => {
    const service = createDdgService({
      enabled: true,
    });

    expect(service.planAlias({
      hostId: "demo",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
    })).toEqual({
      requested: true,
      status: "failed",
      providerKey: "ddg",
      failureReason: "ddg_token_missing",
      failureMessage: "DDG alias provider is enabled but no token is configured in aliasEmail.providers.",
    });
  });

  it("creates a DDG alias when configured", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ address: "alpha-bravo-charlie" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const service = createDdgService({
      enabled: true,
      tokens: ["token"],
      fetchImpl,
    });

    const result = await service.createAliasOutcome({
      hostId: "demo",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
    }, new Date("2026-04-01T00:00:00.000Z"));

    expect(result).toEqual({
      requested: true,
      status: "created",
      providerKey: "ddg",
      alias: {
        providerKey: "ddg",
        emailAddress: "alpha-bravo-charlie@duck.com",
        createdAt: "2026-04-01T00:00:00.000Z",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats DDG as one anonymous provider and can fall back to another provider", async () => {
    const fallbackProvider: MailAliasProvider = {
      providerKey: "anon-mask",
      planAlias() {
        return {
          requested: true,
          status: "will_create",
          providerKey: "anon-mask",
        };
      },
      async createAliasOutcome(_request, now = new Date()) {
        return {
          requested: true,
          status: "created",
          providerKey: "anon-mask",
          alias: {
            providerKey: "anon-mask",
            emailAddress: `mask-${now.getUTCSeconds()}@anon.invalid`,
            createdAt: now.toISOString(),
          },
        };
      },
    };

    const service = createMailAliasService({
      providers: [
        createDdgMailAliasProvider({
          enabled: true,
          tokens: ["token-alpha"],
          fetchImpl: vi.fn(async () => new Response(
            JSON.stringify({ error: "ddg unavailable" }),
            { status: 503, headers: { "content-type": "application/json" } },
          )),
        }),
        fallbackProvider,
      ],
    });

    expect(service.planAlias({
      hostId: "demo",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
    })).toEqual({
      requested: true,
      status: "will_create",
      providerKey: "ddg",
    });

    await expect(service.createAliasOutcome({
      hostId: "demo",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
    }, new Date("2026-04-01T00:00:07.000Z"))).resolves.toEqual({
      requested: true,
      status: "created",
      providerKey: "anon-mask",
      alias: {
        providerKey: "anon-mask",
        emailAddress: "mask-7@anon.invalid",
        createdAt: "2026-04-01T00:00:07.000Z",
      },
    });
  });

  it("degrades to failed outcome when DDG request fails", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: "forbidden" }),
      { status: 403, headers: { "content-type": "application/json" } },
    ));

    const service = createDdgService({
      enabled: true,
      tokens: ["token"],
      fetchImpl,
    });

    const result = await service.createAliasOutcome({
      hostId: "demo",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
    });

    expect(result.requested).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.providerKey).toBe("ddg");
    expect(result.failureReason).toBe("ddg_request_failed");
    expect(result.failureMessage).toContain("DDG alias request failed with status 403");
  });

  it("rotates to the next DDG token when the current token fails", async () => {
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      const authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization || "");
      if (authorization === "Bearer token-alpha") {
        return new Response(
          JSON.stringify({ error: "quota exceeded" }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({ address: "rotated-alias" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const service = createDdgService({
      enabled: true,
      tokens: ["token-alpha", "token-bravo"],
      fetchImpl,
    });

    const result = await service.createAliasOutcome({
      hostId: "demo",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
    }, new Date("2026-04-01T00:00:00.000Z"));

    expect(result).toEqual({
      requested: true,
      status: "created",
      providerKey: "ddg",
      alias: {
        providerKey: "ddg",
        emailAddress: "rotated-alias@duck.com",
        createdAt: "2026-04-01T00:00:00.000Z",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer token-alpha",
      }),
    });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer token-bravo",
      }),
    });
  });

  it("persists daily DDG token usage and blocks exhausted keys after restart", async () => {
    const folder = await mkdtemp(join(tmpdir(), "easy-email-ddg-state-"));
    const stateFilePath = join(folder, "ddg-alias-state.json");
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      const authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization || "");
      if (authorization === "Bearer token-alpha") {
        return new Response(
          JSON.stringify({ address: "alpha-one" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (authorization === "Bearer token-bravo") {
        return new Response(
          JSON.stringify({ address: "bravo-one" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({ error: "unexpected token" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });

    const createService = () => createDdgService({
      enabled: true,
      tokens: ["token-alpha", "token-bravo"],
      dailyLimit: 1,
      stateFilePath,
      fetchImpl,
    });

    const service = createService();
    await expect(service.createAliasOutcome({
      hostId: "demo",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
    }, new Date("2026-04-01T00:00:00.000Z"))).resolves.toMatchObject({
      status: "created",
      alias: {
        emailAddress: "alpha-one@duck.com",
      },
    });

    await expect(service.createAliasOutcome({
      hostId: "demo",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
    }, new Date("2026-04-01T00:01:00.000Z"))).resolves.toMatchObject({
      status: "created",
      alias: {
        emailAddress: "bravo-one@duck.com",
      },
    });

    await expect(service.createAliasOutcome({
      hostId: "demo",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
    }, new Date("2026-04-01T00:02:00.000Z"))).resolves.toEqual({
      requested: true,
      status: "failed",
      providerKey: "ddg",
      failureReason: "ddg_no_available_token",
      failureMessage: "No DDG alias token is currently available. All configured keys are cooling down or have reached today's limit.",
    });

    const restartedService = createService();
    await expect(restartedService.createAliasOutcome({
      hostId: "demo",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
    }, new Date("2026-04-01T00:03:00.000Z"))).resolves.toEqual({
      requested: true,
      status: "failed",
      providerKey: "ddg",
      failureReason: "ddg_no_available_token",
      failureMessage: "No DDG alias token is currently available. All configured keys are cooling down or have reached today's limit.",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer token-alpha",
      }),
    });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer token-bravo",
      }),
    });
  });
});

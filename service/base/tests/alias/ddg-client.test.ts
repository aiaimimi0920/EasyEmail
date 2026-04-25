import { describe, expect, it, vi } from "vitest";
import { DdgAliasClient } from "../../src/alias/ddg/client.js";

describe("ddg alias client", () => {
  it("normalizes aborts into request timeout errors", async () => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("signal missing"));
        return;
      }

      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }));

    const client = new DdgAliasClient({
      apiBaseUrl: "https://quack.duckduckgo.com",
      token: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5,
    });

    try {
      const pending = client.createAlias();
      const failure = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1000);
      const error = await failure;
      expect(error).toMatchObject({
        code: "DDG_ALIAS_REQUEST_FAILED",
      });
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("DDG alias request timed out after 1000ms.");
    } finally {
      vi.useRealTimers();
    }
  });
});

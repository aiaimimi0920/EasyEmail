import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { parseEasyEmailServiceRuntimeConfig } from "../../src/runtime/config.js";
import { installBundledChildControl } from "../../src/runtime/bundled-child-control.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";

describe("ADR 0004 bundled-child private stdin control channel", () => {
  it("stays completely inert in standalone mode without touching stdin", () => {
    const input = new PassThrough();
    const resumeSpy = vi.spyOn(input, "resume");
    const stop = vi.fn().mockResolvedValue(undefined);

    const control = installBundledChildControl(
      { stop, isStopping: () => false },
      { env: {}, input },
    );

    expect(control.enabled).toBe(false);
    expect(resumeSpy).not.toHaveBeenCalled();
    input.write('{"protocolVersion":1,"command":"shutdown"}\n');
    input.end();
    expect(stop).not.toHaveBeenCalled();
  });

  it("handles valid shutdown command idempotently and rejects malformed, oversized, or unauthorized frames", () => {
    const input = new PassThrough();
    const events: string[] = [];
    let stopping = false;
    const stop = vi.fn(async () => {
      stopping = true;
    });

    const control = installBundledChildControl(
      { stop, isStopping: () => stopping },
      {
        env: {
          EASY_EMAIL_BUNDLED_CHILD_MODE: "1",
          EASY_EMAIL_BUNDLED_CONTROL_TOKEN: "secret-parent-control-token",
        },
        input,
        report: (event) => events.push(event),
      },
    );

    expect(control.enabled).toBe(true);

    // Malformed JSON, unsupported version, unknown command, oversized frame, and wrong token
    input.write("not-json\n");
    input.write('{"protocolVersion":2,"command":"shutdown","controlToken":"secret-parent-control-token"}\n');
    input.write('{"protocolVersion":1,"command":"reload","controlToken":"secret-parent-control-token"}\n');
    input.write(`${"x".repeat(5000)}\n`);
    input.write('{"protocolVersion":1,"command":"shutdown","controlToken":"wrong-token"}\n');

    expect(stop).not.toHaveBeenCalled();
    expect(events).toEqual([
      "easy_email_control_message_invalid",
      "easy_email_control_message_invalid",
      "easy_email_control_message_invalid",
      "easy_email_control_frame_too_large",
      "easy_email_control_unauthorized",
    ]);
    expect(events.join("\n")).not.toContain("secret-parent-control-token");

    // Valid authenticated shutdown frame (split across two chunks) + repeated frame
    input.write('{"protocolVersion":1,"command":"shutdown",');
    input.write('"controlToken":"secret-parent-control-token"}\n');
    input.write('{"protocolVersion":1,"command":"shutdown","controlToken":"secret-parent-control-token"}\n');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toBe("[easy_email] bundled_control_shutdown reason=command");
  });

  it("treats parent-pipe EOF as unexpected parent exit and triggers bounded shutdown", async () => {
    const input = new PassThrough();
    const events: string[] = [];
    let stopping = false;
    const stop = vi.fn(async () => {
      stopping = true;
    });

    installBundledChildControl(
      { stop, isStopping: () => stopping },
      {
        env: { EASY_EMAIL_BUNDLED_CHILD_MODE: "1" },
        input,
        report: (event) => events.push(event),
      },
    );

    input.end();
    await new Promise((resolve) => setImmediate(resolve));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["[easy_email] bundled_control_shutdown reason=parent_eof"]);
  });

  it("exposes bundled instance nonce only on authenticated responses and drains idle keep-alive sockets on close", async () => {
    const previousMode = process.env.EASY_EMAIL_BUNDLED_CHILD_MODE;
    const previousNonce = process.env.EASY_EMAIL_BUNDLED_INSTANCE_NONCE;
    process.env.EASY_EMAIL_BUNDLED_CHILD_MODE = "1";
    process.env.EASY_EMAIL_BUNDLED_INSTANCE_NONCE = "nonce-child-proof-123";

    const runtime = await startEasyEmailServiceRuntime({
      config: parseEasyEmailServiceRuntimeConfig({
        server: { host: "127.0.0.1", port: 0, apiKey: "test-bundled-key" },
        maintenance: { enabled: false },
        persistence: { enabled: false, intervalMs: 60_000 },
        providers: { enabledProviders: [] },
      }),
      sendQueueWorkerEnabled: false,
    });

    try {
      const unauth = await fetch(`${runtime.server.baseUrl}/mail/catalog`);
      expect(unauth.status).toBe(401);
      expect(unauth.headers.get("x-easyemail-bundled-nonce")).toBeNull();
      await unauth.arrayBuffer();

      const auth = await fetch(`${runtime.server.baseUrl}/mail/catalog`, {
        headers: { authorization: "Bearer test-bundled-key" },
      });
      expect(auth.status).toBe(200);
      expect(auth.headers.get("x-easyemail-bundled-nonce")).toBe("nonce-child-proof-123");
      await auth.arrayBuffer();

      const closeStarted = Date.now();
      await runtime.close();
      expect(Date.now() - closeStarted).toBeLessThan(2_000);
    } finally {
      if (previousMode === undefined) delete process.env.EASY_EMAIL_BUNDLED_CHILD_MODE;
      else process.env.EASY_EMAIL_BUNDLED_CHILD_MODE = previousMode;
      if (previousNonce === undefined) delete process.env.EASY_EMAIL_BUNDLED_INSTANCE_NONCE;
      else process.env.EASY_EMAIL_BUNDLED_INSTANCE_NONCE = previousNonce;
      await runtime.close();
    }
  });
});

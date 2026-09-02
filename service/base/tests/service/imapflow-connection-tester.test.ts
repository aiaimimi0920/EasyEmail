import { describe, expect, it } from "vitest";

import { EasyEmailError } from "../../src/domain/errors.js";
import {
  ImapFlowConnectionTester,
  type ImapFlowClientFactory,
} from "../../src/service/imapflow-connection-tester.js";

const PROFILE = {
  protocol: "imap" as const,
  host: "imap.example.com",
  port: 993,
  security: "tls" as const,
  username: "user@example.com",
};

describe("ImapFlowConnectionTester", () => {
  it("uses strict TLS, disables logging, reports sorted capabilities, and logs out", async () => {
    const observed: Parameters<ImapFlowClientFactory>[0][] = [];
    let logoutCalls = 0;
    let closeCalls = 0;
    const tester = new ImapFlowConnectionTester({
      connectionTimeoutMs: 1_500,
      createClient(options) {
        observed.push(options);
        return {
          capabilities: new Map([["IDLE", true], ["IMAP4rev1", true]]),
          async connect() {},
          async logout() { logoutCalls += 1; },
          close() { closeCalls += 1; },
        };
      },
    });

    await expect(tester.testConnection(PROFILE, "imap-test-secret"))
      .resolves.toEqual({ authenticated: true, capabilitySummary: "IDLE IMAP4rev1" });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      host: "imap.example.com",
      port: 993,
      secure: true,
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 1_500,
      greetingTimeout: 1_500,
      socketTimeout: 1_500,
      auth: { user: "user@example.com", pass: "imap-test-secret" },
      tls: { minVersion: "TLSv1.2" },
    });
    expect(observed[0]?.doSTARTTLS).toBeUndefined();
    expect(logoutCalls).toBe(1);
    expect(closeCalls).toBe(0);
  });

  it("requires STARTTLS and maps authentication failures without exposing details", async () => {
    let closeCalls = 0;
    const tester = new ImapFlowConnectionTester({
      createClient(options) {
        expect(options).toMatchObject({ secure: false, doSTARTTLS: true });
        return {
          capabilities: new Map(),
          async connect() {
            throw { authenticationFailed: true, response: "imap-test-secret" };
          },
          async logout() { throw new Error("must not logout"); },
          close() { closeCalls += 1; },
        };
      },
    });

    const promise = tester.testConnection({ ...PROFILE, port: 143, security: "starttls" }, "imap-test-secret");
    await expect(promise).rejects.toMatchObject({
      code: "IMAP_AUTH_FAILED",
      message: "The IMAP server rejected the account credential.",
    } satisfies Partial<EasyEmailError>);
    await expect(promise).rejects.not.toThrow("imap-test-secret");
    expect(closeCalls).toBe(1);
  });

  it("closes failed network connections and preserves only the generic transport error", async () => {
    let closeCalls = 0;
    const tester = new ImapFlowConnectionTester({
      createClient() {
        return {
          capabilities: new Map(),
          async connect() { throw new Error("socket unavailable"); },
          async logout() {},
          close() { closeCalls += 1; },
        };
      },
    });

    await expect(tester.testConnection(PROFILE, "imap-test-secret"))
      .rejects.toThrow("socket unavailable");
    expect(closeCalls).toBe(1);
  });

  it("bounds logout cleanup and closes a stalled authenticated connection", async () => {
    let closeCalls = 0;
    const tester = new ImapFlowConnectionTester({
      connectionTimeoutMs: 100,
      createClient() {
        return {
          capabilities: new Map(),
          async connect() {},
          async logout() { await new Promise(() => undefined); },
          close() { closeCalls += 1; },
        };
      },
    });

    const startedAt = Date.now();
    await expect(tester.testConnection(PROFILE, "imap-test-secret"))
      .resolves.toEqual({ authenticated: true, capabilitySummary: "IMAP authenticated" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(closeCalls).toBe(1);
  });
});

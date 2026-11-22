import { afterEach, describe, expect, it, vi } from "vitest";
import { MailRegistry } from "../../src/domain/registry.js";
import { CloudflareTempEmailCreateClient } from "../../src/providers/cloudflare_temp_email/connector/client.js";

describe.each(["subject", "body"] as const)("Cloudflare %s message identity", (codeLocation) => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { provider: "instance-a", session: "session-b", scope: "mailbox sessions" },
    { provider: "instance-b", session: "session-a", scope: "provider instances" },
  ])("preserves separate records across $scope when upstream IDs repeat", async ({ provider, session }) => {
    let fixtureCode = "123456";
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/api/mails") {
        return Response.json({ results: [{
          id: 7,
          source: "sender@fixture.example",
          subject: codeLocation === "subject" ? `Verification code: ${fixtureCode}` : "Verification message",
        }] });
      }
      if (path === "/api/mail/7") {
        return Response.json({ raw: [
          "Date: Thu, 10 Sep 2026 12:00:00 +0000",
          "Content-Type: text/plain; charset=utf-8",
          "",
          codeLocation === "body" ? `Your verification code is ${fixtureCode}.` : "Fixture body",
        ].join("\r\n") });
      }
      throw new Error(`Unexpected fixture route: ${path}`);
    }));

    const client = new CloudflareTempEmailCreateClient({
      baseUrl: "https://mail.fixture.example",
      domains: [],
      randomSubdomainDomains: [],
      timeoutSeconds: 5,
    });
    const registry = new MailRegistry();
    const mailbox = { address: "first@fixture.example", jwt: "fixture-first" };
    const first = await client.tryReadLatestCode("session-a", mailbox, "instance-a");
    expect(first?.extractedCode).toBe("123456");
    if (!first) throw new Error("First fixture message is missing");
    registry.saveMessage(first);

    const repeated = await client.tryReadLatestCode("session-a", mailbox, "instance-a");
    expect(repeated?.id).toBe(first.id);
    if (!repeated) throw new Error("Repeated fixture message is missing");
    registry.saveMessage(repeated);
    expect(registry.listMessages()).toHaveLength(1);

    fixtureCode = "654321";
    const second = await client.tryReadLatestCode(session, {
      address: "second@fixture.example",
      jwt: "fixture-second",
    }, provider);
    expect(second?.extractedCode).toBe("654321");
    if (!second) throw new Error("Second fixture message is missing");
    registry.saveMessage(second);

    expect(registry.listMessages()).toHaveLength(2);
    expect(registry.listMessages()).toContainEqual(first);
    expect(registry.listMessages()).toContainEqual(second);
  });
});

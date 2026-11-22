import assert from "node:assert/strict";
import test from "node:test";

import { createEasyEmailHttpClient } from "../src/api/easyEmailHttpClient.ts";

test("dispatches M7A promotion, newsletter subscription, and EasyEmail settings routes with Bearer auth", async () => {
  const calls: Array<{ url: string; method: string; headers: Headers; body: string | null }> = [];
  const client = createEasyEmailHttpClient({
    baseUrl: "http://127.0.0.1:18787",
    bearerToken: "desktop-m7a-token",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : null,
      });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/promote")) {
        return new Response(
          JSON.stringify({
            account: {
              id: "acct_v1_promoted",
              scope: "normal",
              kind: "normal_upgraded_temp",
              displayName: "Promoted",
              primaryAddress: "temp@example.test",
              status: "ready",
              authStatus: "not_required",
              receiveStatus: "enabled",
              sendStatus: "unsupported",
              listedInAllAccounts: true,
              version: 1,
              createdAt: "2026-09-25T00:00:00.000Z",
              updatedAt: "2026-09-25T00:00:00.000Z",
              credentialRefs: [],
            },
            session: {
              id: "ses/1",
              hostId: "desktop",
              providerTypeKey: "mailtm",
              providerInstanceId: "inst-1",
              emailAddress: "temp@example.test",
              mailboxRef: "ref:1",
              status: "open",
              createdAt: "2026-09-25T00:00:00.000Z",
              metadata: {
                visibilityState: "upgraded",
                upgradedAccountId: "acct_v1_promoted",
              },
            },
            linkedMessageCount: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (parsed.pathname === "/mail/newsletters/subscriptions") {
        return new Response(JSON.stringify({ subscriptions: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (parsed.pathname.startsWith("/mail/newsletters/subscriptions/")) {
        return new Response(
          JSON.stringify({
            action: {
              accountId: "acct-1",
              subscriptionId: "list:weekly",
              hidden: true,
              changed: true,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (parsed.pathname === "/mail/settings/easyemail" && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({ settings: { serviceUrl: null, hasApiToken: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (parsed.pathname === "/mail/settings/easyemail" && init?.method === "PATCH") {
        return new Response(
          JSON.stringify({
            settings: { serviceUrl: "http://127.0.0.1:8787", hasApiToken: false },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          health: {
            reachable: true,
            providerCount: 2,
            authStatus: "configured",
            capabilitiesSummary: "temporary mail and verification",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const promoted = await client.promoteMailbox("ses/1", { confirmLifecycleAck: true });
  assert.equal(promoted.account.id, "acct_v1_promoted");
  assert.match(calls[0].url, /\/mail\/mailboxes\/ses%2F1\/promote$/);
  assert.equal(calls[0].headers.get("authorization"), "Bearer desktop-m7a-token");

  await client.listNewsletterSubscriptions({ accountId: "acct-1" });
  assert.match(calls[1].url, /\/mail\/newsletters\/subscriptions\?accountId=acct-1$/);

  await client.setNewsletterSubscriptionHidden("list:weekly", {
    accountId: "acct-1",
    hidden: true,
  });
  assert.match(calls[2].url, /\/mail\/newsletters\/subscriptions\/list%3Aweekly$/);

  const settings = await client.getEasyEmailSettings();
  assert.equal(settings.settings.hasApiToken, true);

  const updated = await client.updateEasyEmailSettings({
    serviceUrl: "http://127.0.0.1:8787",
  });
  assert.equal(updated.settings.serviceUrl, "http://127.0.0.1:8787");

  const health = await client.testEasyEmailConnection({ serviceUrl: null, apiToken: null });
  assert.equal(health.health.providerCount, 2);
});

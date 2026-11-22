import assert from "node:assert/strict";
import test from "node:test";

import { EasyEmailClient } from "../dist/index.js";

test("M7A mailbox promotion, newsletter subscriptions, and EasyEmail settings SDK methods use canonical HTTP routes", async () => {
  const calls = [];
  const client = new EasyEmailClient({
    baseUrl: "http://127.0.0.1:18084",
    apiKey: "sdk-m7a-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/promote") && init.method === "POST") {
        return new Response(
          JSON.stringify({
            account: {
              id: "acct_v1_promoted",
              scope: "normal",
              kind: "normal_upgraded_temp",
              displayName: "Promoted Temp",
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
              hostId: "github.com",
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
            linkedMessageCount: 2,
          }),
          { status: 200 },
        );
      }
      if (parsed.pathname === "/mail/newsletters/subscriptions" && init.method === "GET") {
        return new Response(
          JSON.stringify({
            subscriptions: [
              {
                id: "list:weekly.example",
                listId: "weekly.example",
                senderAddress: "digest@weekly.example",
                name: "Weekly Digest",
                receivedMessageCount: 3,
                unreadMessageCount: 1,
                lastReceivedAt: "2026-09-25T01:00:00.000Z",
                unsubscribeMethods: ["https://weekly.example/unsub"],
                spam: false,
                hidden: false,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (parsed.pathname.startsWith("/mail/newsletters/subscriptions/") && init.method === "PATCH") {
        return new Response(
          JSON.stringify({
            action: {
              accountId: "acct-1",
              subscriptionId: "list:weekly.example",
              hidden: true,
              changed: true,
            },
          }),
          { status: 200 },
        );
      }
      if (parsed.pathname === "/mail/settings/easyemail" && init.method === "GET") {
        return new Response(
          JSON.stringify({
            settings: { serviceUrl: "http://127.0.0.1:8787", hasApiToken: true },
          }),
          { status: 200 },
        );
      }
      if (parsed.pathname === "/mail/settings/easyemail" && init.method === "PATCH") {
        return new Response(
          JSON.stringify({
            settings: { serviceUrl: "https://mail.example.com", hasApiToken: false },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          health: {
            reachable: true,
            providerCount: 4,
            authStatus: "authenticated",
            capabilitiesSummary: "temporary mail and verification",
          },
        }),
        { status: 200 },
      );
    },
  });

  const promoted = await client.promoteMailboxSession("ses/1", {
    confirmLifecycleAck: true,
    displayName: "Promoted Temp",
  });
  assert.equal(promoted.account.kind, "normal_upgraded_temp");
  assert.equal(promoted.linkedMessageCount, 2);
  assert.match(calls[0].url, /\/mail\/mailboxes\/ses%2F1\/promote$/);

  const subscriptions = await client.listNewsletterSubscriptions({ accountId: "acct-1" });
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].id, "list:weekly.example");
  assert.match(calls[1].url, /\/mail\/newsletters\/subscriptions\?accountId=acct-1$/);

  const updatedSub = await client.setNewsletterSubscriptionHidden("list:weekly.example", {
    accountId: "acct-1",
    hidden: true,
  });
  assert.equal(updatedSub.hidden, true);
  assert.match(calls[2].url, /\/mail\/newsletters\/subscriptions\/list%3Aweekly\.example$/);

  const settings = await client.getEasyEmailSettings();
  assert.equal(settings.serviceUrl, "http://127.0.0.1:8787");
  assert.equal(settings.hasApiToken, true);

  const updatedSettings = await client.updateEasyEmailSettings({
    serviceUrl: "https://mail.example.com",
  });
  assert.equal(updatedSettings.serviceUrl, "https://mail.example.com");

  const health = await client.testEasyEmailConnection({
    serviceUrl: "https://mail.example.com",
    apiToken: "probe-token",
  });
  assert.equal(health.providerCount, 4);
  assert.match(calls[5].url, /\/mail\/settings\/easyemail\/test$/);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  createNewsletterClient,
  type NewsletterHttpTransport,
  type NewsletterSubscriptionActionDto,
  type NewsletterSubscriptionDto,
  type NewsletterSubscriptionListRequest,
  type NewsletterSubscriptionSetHiddenRequest,
} from "../src/api/newsletterClient.ts";

test("lists newsletter subscriptions over HTTP and maps snake_case DTO fields", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const transport: NewsletterHttpTransport = {
    async listNewsletterSubscriptions(query) {
      calls.push({ method: "listNewsletterSubscriptions", args: [query] });
      return {
        subscriptions: [
          {
            id: "list:newsletter-list-1",
            listId: "newsletter-list-1",
            senderAddress: "news@example.com",
            name: "Example Weekly",
            receivedMessageCount: 12,
            unreadMessageCount: 3,
            lastReceivedAt: "2026-07-25T08:30:00Z",
            unsubscribeMethods: [
              "mailto:unsubscribe@example.com",
              "https://example.com/unsubscribe",
            ],
            spam: false,
            hidden: false,
          },
        ],
      };
    },
    async setNewsletterSubscriptionHidden() {
      throw new Error("unexpected");
    },
  };

  const request: NewsletterSubscriptionListRequest = { account_id: "account-1" };
  const result: NewsletterSubscriptionDto[] =
    await createNewsletterClient(transport).listNewsletterSubscriptions(request);

  assert.deepEqual(result, [
    {
      id: "list:newsletter-list-1",
      list_id: "newsletter-list-1",
      sender_address: "news@example.com",
      name: "Example Weekly",
      received_message_count: 12,
      unread_message_count: 3,
      last_received_at: "2026-07-25T08:30:00Z",
      unsubscribe_methods: [
        "mailto:unsubscribe@example.com",
        "https://example.com/unsubscribe",
      ],
      spam: false,
      hidden: false,
    },
  ]);
  assert.deepEqual(calls, [
    { method: "listNewsletterSubscriptions", args: [{ accountId: "account-1" }] },
  ]);
});

test("sets newsletter hidden state over HTTP with hidden false preserved", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const transport: NewsletterHttpTransport = {
    async listNewsletterSubscriptions() {
      throw new Error("unexpected");
    },
    async setNewsletterSubscriptionHidden(subscriptionId, request) {
      calls.push({
        method: "setNewsletterSubscriptionHidden",
        args: [subscriptionId, request],
      });
      return {
        action: {
          accountId: request.accountId,
          subscriptionId,
          hidden: request.hidden,
          changed: true,
        },
      };
    },
  };

  const request: NewsletterSubscriptionSetHiddenRequest = {
    account_id: "account-1",
    subscription_id: "subscription-1",
    hidden: false,
  };
  const result: NewsletterSubscriptionActionDto =
    await createNewsletterClient(transport).setNewsletterSubscriptionHidden(request);

  assert.deepEqual(result, {
    account_id: "account-1",
    subscription_id: "subscription-1",
    hidden: false,
    changed: true,
  });
  assert.deepEqual(calls, [
    {
      method: "setNewsletterSubscriptionHidden",
      args: ["subscription-1", { accountId: "account-1", hidden: false }],
    },
  ]);
});

test("propagates HTTP transport rejection unchanged", async () => {
  const rejection = {
    code: "EXTENSIONS_PERSISTENCE_UNAVAILABLE",
    message: "Persistent mail extensions are not available.",
  };
  const transport: NewsletterHttpTransport = {
    async listNewsletterSubscriptions() {
      throw rejection;
    },
    async setNewsletterSubscriptionHidden() {
      throw rejection;
    },
  };

  await assert.rejects(
    createNewsletterClient(transport).listNewsletterSubscriptions({
      account_id: "account-1",
    }),
    (caught: unknown) => {
      assert.strictEqual(caught, rejection);
      return true;
    },
  );
});

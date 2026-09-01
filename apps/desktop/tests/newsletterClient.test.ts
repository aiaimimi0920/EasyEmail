import assert from "node:assert/strict";
import test from "node:test";

import {
  createNewsletterClient,
  type NewsletterSubscriptionActionDto,
  type NewsletterSubscriptionDto,
  type NewsletterSubscriptionListRequest,
  type NewsletterSubscriptionSetHiddenRequest,
} from "../src/api/newsletterClient.ts";
import type { InvokeCommand } from "../src/api/invokeCommand.ts";

type InvokeCall = {
  command: string;
  args: Record<string, unknown> | undefined;
};

function createFakeInvoke(responses: ReadonlyMap<string, unknown>) {
  const calls: InvokeCall[] = [];
  const invokeCommand: InvokeCommand = async <T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    calls.push({ command, args });
    if (!responses.has(command)) {
      throw new Error(`Unexpected command: ${command}`);
    }
    return responses.get(command) as T;
  };

  return { calls, invokeCommand };
}

test("lists newsletter subscriptions with the exact command and request envelope", async () => {
  const request: NewsletterSubscriptionListRequest = {
    account_id: "account-1",
  };
  const subscription: NewsletterSubscriptionDto = {
    id: "subscription-1",
    list_id: "newsletter-list-1",
    sender_address: "news@example.com",
    name: "Example Weekly",
    received_message_count: 12,
    unread_message_count: 3,
    last_received_at: "2026-07-25T08:30:00Z",
    unsubscribe_methods: ["mailto:unsubscribe@example.com", "https://example.com/unsubscribe"],
    spam: false,
    hidden: false,
  };
  const subscriptions = [subscription];
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["newsletter_subscription_list", subscriptions]]),
  );

  const result = await createNewsletterClient(invokeCommand).listNewsletterSubscriptions(
    request,
  );

  assert.strictEqual(result, subscriptions);
  assert.strictEqual(result[0], subscription);
  assert.strictEqual(result[0].unsubscribe_methods, subscription.unsubscribe_methods);
  assert.deepEqual(result[0], {
    id: "subscription-1",
    list_id: "newsletter-list-1",
    sender_address: "news@example.com",
    name: "Example Weekly",
    received_message_count: 12,
    unread_message_count: 3,
    last_received_at: "2026-07-25T08:30:00Z",
    unsubscribe_methods: ["mailto:unsubscribe@example.com", "https://example.com/unsubscribe"],
    spam: false,
    hidden: false,
  });
  assert.deepEqual(calls, [
    {
      command: "newsletter_subscription_list",
      args: { request },
    },
  ]);
  assert.deepEqual(Object.keys(calls[0].args ?? {}), ["request"]);
  assert.strictEqual(calls[0].args?.request, request);
});

test("sets newsletter hidden state with hidden false preserved exactly", async () => {
  const request: NewsletterSubscriptionSetHiddenRequest = {
    account_id: "account-1",
    subscription_id: "subscription-1",
    hidden: false,
  };
  const action: NewsletterSubscriptionActionDto = {
    account_id: "account-1",
    subscription_id: "subscription-1",
    hidden: false,
    changed: true,
  };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["newsletter_subscription_set_hidden", action]]),
  );

  const result = await createNewsletterClient(
    invokeCommand,
  ).setNewsletterSubscriptionHidden(request);

  assert.strictEqual(result, action);
  assert.deepEqual(result, {
    account_id: "account-1",
    subscription_id: "subscription-1",
    hidden: false,
    changed: true,
  });
  assert.deepEqual(calls, [
    {
      command: "newsletter_subscription_set_hidden",
      args: { request },
    },
  ]);
  assert.deepEqual(Object.keys(calls[0].args ?? {}), ["request"]);
  assert.strictEqual(calls[0].args?.request, request);
  assert.equal(
    Object.prototype.hasOwnProperty.call(calls[0].args?.request, "hidden"),
    true,
  );
  assert.strictEqual(
    (calls[0].args?.request as NewsletterSubscriptionSetHiddenRequest).hidden,
    false,
  );
});

test("propagates the exact invoke rejection object unchanged", async () => {
  const rejection = {
    code: "newsletter_subscription_unavailable",
    message: "Newsletter subscription storage is unavailable",
  };
  const invokeCommand: InvokeCommand = <T>(): Promise<T> =>
    Promise.reject<T>(rejection);

  await assert.rejects(
    createNewsletterClient(invokeCommand).listNewsletterSubscriptions({
      account_id: "account-1",
    }),
    (caught: unknown) => {
      assert.strictEqual(caught, rejection);
      return true;
    },
  );
});

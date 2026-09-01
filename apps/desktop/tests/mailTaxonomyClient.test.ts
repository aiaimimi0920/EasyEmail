import assert from "node:assert/strict";
import test from "node:test";

import {
  createMailTaxonomyClient,
  type MailTaxonomyDeleteDto,
  type MailTaxonomyDeleteRequest,
  type MailTaxonomyItemDto,
  type MailTaxonomyListRequest,
  type MailTaxonomyUpdateRequest,
  type MailTaxonomyUpsertRequest,
} from "../src/api/mailTaxonomyClient.ts";
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

test("lists folders with mail_taxonomy_list and exactly the wrapped request payload", async () => {
  const request: MailTaxonomyListRequest = { kind: "folder" };
  const folders: MailTaxonomyItemDto[] = [
    {
      id: "folder-inbox",
      kind: "folder",
      name: "Inbox",
      parent_id: null,
      color: "#7c3aed",
      sort_order: 0,
      system: true,
    },
  ];
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["mail_taxonomy_list", folders]]),
  );

  const result = await createMailTaxonomyClient(invokeCommand).listMailTaxonomyItems(
    request,
  );

  assert.strictEqual(result, folders);
  assert.ok(Array.isArray(result));
  assert.deepEqual(calls, [
    {
      command: "mail_taxonomy_list",
      args: { request },
    },
  ]);
  assert.deepEqual(Object.keys(calls[0].args ?? {}), ["request"]);
  assert.strictEqual(calls[0].args?.request, request);
});

test("preserves label kind when listing taxonomy items", async () => {
  const request: MailTaxonomyListRequest = { kind: "label" };
  const labels: MailTaxonomyItemDto[] = [];
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["mail_taxonomy_list", labels]]),
  );

  const result = await createMailTaxonomyClient(invokeCommand).listMailTaxonomyItems(
    request,
  );

  assert.strictEqual(result, labels);
  assert.deepEqual(calls, [
    {
      command: "mail_taxonomy_list",
      args: { request: { kind: "label" } },
    },
  ]);
  assert.strictEqual(calls[0].args?.request, request);
});

test("upserts a taxonomy item with the exact request including a non-null parent_id", async () => {
  const request: MailTaxonomyUpsertRequest = {
    kind: "folder",
    name: "Receipts",
    parent_id: "folder-finance",
    color: "#06b6d4",
  };
  const item: MailTaxonomyItemDto = {
    id: "folder-receipts",
    ...request,
    sort_order: 4,
    system: false,
  };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["mail_taxonomy_upsert", item]]),
  );

  const result = await createMailTaxonomyClient(invokeCommand).upsertMailTaxonomyItem(
    request,
  );

  assert.strictEqual(result, item);
  assert.deepEqual(calls, [
    {
      command: "mail_taxonomy_upsert",
      args: { request },
    },
  ]);
  assert.deepEqual(Object.keys(calls[0].args ?? {}), ["request"]);
  assert.strictEqual(calls[0].args?.request, request);
  assert.equal(request.parent_id, "folder-finance");
});

test("updates a label with the exact request including parent_id null", async () => {
  const request: MailTaxonomyUpdateRequest = {
    id: "label-important",
    name: "Important",
    parent_id: null,
    color: "#d9ff38",
  };
  const item: MailTaxonomyItemDto = {
    id: request.id,
    kind: "label",
    name: request.name,
    parent_id: request.parent_id,
    color: request.color,
    sort_order: 2,
    system: false,
  };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["mail_taxonomy_update", item]]),
  );

  const result = await createMailTaxonomyClient(invokeCommand).updateMailTaxonomyItem(
    request,
  );

  assert.strictEqual(result, item);
  assert.deepEqual(calls, [
    {
      command: "mail_taxonomy_update",
      args: { request },
    },
  ]);
  assert.deepEqual(Object.keys(calls[0].args ?? {}), ["request"]);
  assert.strictEqual(calls[0].args?.request, request);
  assert.equal(request.parent_id, null);
});

test("deletes a taxonomy item with the exact request and returns the changed result", async () => {
  const request: MailTaxonomyDeleteRequest = { id: "label-important" };
  const deleted: MailTaxonomyDeleteDto = {
    id: request.id,
    changed: true,
  };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["mail_taxonomy_delete", deleted]]),
  );

  const result = await createMailTaxonomyClient(invokeCommand).deleteMailTaxonomyItem(
    request,
  );

  assert.strictEqual(result, deleted);
  assert.equal(result.changed, true);
  assert.deepEqual(calls, [
    {
      command: "mail_taxonomy_delete",
      args: { request },
    },
  ]);
  assert.deepEqual(Object.keys(calls[0].args ?? {}), ["request"]);
  assert.strictEqual(calls[0].args?.request, request);
});

test("passes through a full taxonomy DTO with nullable parent_id unchanged", async () => {
  const item: MailTaxonomyItemDto = {
    id: "label-openai",
    kind: "label",
    name: "OpenAI",
    parent_id: null,
    color: "#8b5cf6",
    sort_order: 7,
    system: false,
  };
  const items = [item];
  const { invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["mail_taxonomy_list", items]]),
  );

  const result = await createMailTaxonomyClient(invokeCommand).listMailTaxonomyItems({
    kind: "label",
  });

  assert.strictEqual(result, items);
  assert.strictEqual(result[0], item);
  assert.deepEqual(result[0], {
    id: "label-openai",
    kind: "label",
    name: "OpenAI",
    parent_id: null,
    color: "#8b5cf6",
    sort_order: 7,
    system: false,
  });
});

test("propagates the exact invoke rejection object unchanged", async () => {
  const rejection = {
    code: "mail_taxonomy_unavailable",
    message: "Mail taxonomy storage is unavailable",
  };
  const invokeCommand: InvokeCommand = <T>(): Promise<T> =>
    Promise.reject<T>(rejection);

  await assert.rejects(
    createMailTaxonomyClient(invokeCommand).deleteMailTaxonomyItem({
      id: "folder-archive",
    }),
    (caught: unknown) => {
      assert.strictEqual(caught, rejection);
      return true;
    },
  );
});

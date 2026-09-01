import assert from "node:assert/strict";
import test from "node:test";

import {
  createContactClient,
  type ContactCreateRequest,
  type ContactDto,
} from "../src/api/contactClient.ts";
import type { InvokeCommand } from "../src/api/invokeCommand.ts";

type InvokeCall =
  | { command: string }
  | { command: string; args: Record<string, unknown> };

function createFakeInvoke(responses: ReadonlyMap<string, unknown>) {
  const calls: InvokeCall[] = [];
  const invokeCommand: InvokeCommand = async <T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    calls.push(args === undefined ? { command } : { command, args });
    if (!responses.has(command)) {
      throw new Error(`Unexpected command: ${command}`);
    }
    return responses.get(command) as T;
  };

  return { calls, invokeCommand };
}

test("lists contacts with contact_list and no argument object", async () => {
  const contacts: ContactDto[] = [
    {
      id: "contact-1",
      display_name: "Ada Lovelace",
      email_address: "ada@example.com",
      note: null,
      created_at: "2026-07-24T09:00:00Z",
      updated_at: "2026-07-24T09:00:00Z",
    },
  ];
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["contact_list", contacts]]),
  );

  const result = await createContactClient(invokeCommand).listContacts();

  assert.strictEqual(result, contacts);
  assert.deepEqual(calls, [{ command: "contact_list" }]);
  assert.equal("args" in calls[0], false);
});

test("creates a contact with contact_create and exactly the wrapped request payload", async () => {
  const request: ContactCreateRequest = {
    display_name: "Grace Hopper",
    email_address: "grace@example.com",
    note: "Compiler pioneer",
  };
  const createdContact: ContactDto = {
    id: "contact-2",
    ...request,
    created_at: "2026-07-24T10:00:00Z",
    updated_at: "2026-07-24T10:00:00Z",
  };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["contact_create", createdContact]]),
  );

  const result = await createContactClient(invokeCommand).createContact(request);

  assert.strictEqual(result, createdContact);
  assert.deepEqual(calls, [
    {
      command: "contact_create",
      args: { request },
    },
  ]);
  const createCall = calls[0];
  assert.ok("args" in createCall);
  assert.strictEqual(createCall.args.request, request);
});

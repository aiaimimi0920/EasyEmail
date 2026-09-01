import assert from "node:assert/strict";
import test from "node:test";

import {
  createContactClient,
  type ContactCreateRequest,
  type ContactHttpTransport,
} from "../src/api/contactClient.ts";
import type {
  EasyEmailContact,
  EasyEmailContactCreateRequest,
} from "../src/api/easyEmailHttpClient.ts";

const contact: EasyEmailContact = {
  id: "contact-1",
  displayName: "Ada Lovelace",
  emailAddress: "ada@example.com",
  version: 1,
  createdAt: "2026-07-24T09:00:00Z",
  updatedAt: "2026-07-24T09:00:00Z",
};

test("maps canonical HTTP contacts into the existing UI DTO", async () => {
  const listQueries: unknown[] = [];
  const secondContact: EasyEmailContact = {
    ...contact,
    id: "contact-2",
    displayName: "Grace Hopper",
    emailAddress: "grace@example.com",
  };
  const transport: ContactHttpTransport = {
    async listContacts(query) {
      listQueries.push(query);
      return listQueries.length === 1
        ? { contacts: [contact], nextCursor: "page-2" }
        : { contacts: [secondContact] };
    },
    async createContact() {
      throw new Error("unexpected create");
    },
  };

  assert.deepEqual(await createContactClient(transport).listContacts(), [
    {
      id: "contact-1",
      display_name: "Ada Lovelace",
      email_address: "ada@example.com",
      note: null,
      created_at: "2026-07-24T09:00:00Z",
      updated_at: "2026-07-24T09:00:00Z",
    },
    {
      id: "contact-2",
      display_name: "Grace Hopper",
      email_address: "grace@example.com",
      note: null,
      created_at: "2026-07-24T09:00:00Z",
      updated_at: "2026-07-24T09:00:00Z",
    },
  ]);
  assert.deepEqual(listQueries, [
    { limit: 100, cursor: undefined },
    { limit: 100, cursor: "page-2" },
  ]);
});

test("maps the existing UI create request to the canonical HTTP request", async () => {
  const request: ContactCreateRequest = {
    display_name: "Grace Hopper",
    email_address: "grace@example.com",
    note: "Compiler pioneer",
  };
  let captured: EasyEmailContactCreateRequest | undefined;
  const transport: ContactHttpTransport = {
    async listContacts() {
      throw new Error("unexpected list");
    },
    async createContact(httpRequest) {
      captured = httpRequest;
      return {
        contact: {
          ...contact,
          id: "contact-2",
          displayName: httpRequest.displayName ?? "",
          emailAddress: httpRequest.emailAddress,
          note: httpRequest.note ?? undefined,
        },
      };
    },
  };

  const result = await createContactClient(transport).createContact(request);

  assert.deepEqual(captured, {
    displayName: "Grace Hopper",
    emailAddress: "grace@example.com",
    note: "Compiler pioneer",
  });
  assert.deepEqual(result, {
    id: "contact-2",
    display_name: "Grace Hopper",
    email_address: "grace@example.com",
    note: "Compiler pioneer",
    created_at: contact.createdAt,
    updated_at: contact.updatedAt,
  });
});

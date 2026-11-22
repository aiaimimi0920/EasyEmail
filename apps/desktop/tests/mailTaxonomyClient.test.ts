import assert from "node:assert/strict";
import test from "node:test";

import {
  createMailTaxonomyClient,
  toMailTaxonomySlugKey,
  type MailTaxonomyDeleteDto,
  type MailTaxonomyDeleteRequest,
  type MailTaxonomyHttpTransport,
  type MailTaxonomyItemDto,
  type MailTaxonomyListRequest,
  type MailTaxonomyUpdateRequest,
  type MailTaxonomyUpsertRequest,
} from "../src/api/mailTaxonomyClient.ts";

function createFakeTaxonomyTransport(overrides: Partial<MailTaxonomyHttpTransport> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const transport: MailTaxonomyHttpTransport = {
    async listMailTaxonomy(query) {
      calls.push({ method: "listMailTaxonomy", args: [query] });
      return {
        items: [],
        capabilities: { messageReferencePropagation: true },
      };
    },
    async getMailTaxonomy(itemId) {
      calls.push({ method: "getMailTaxonomy", args: [itemId] });
      return {
        item: {
          id: itemId,
          kind: "folder",
          name: "Existing",
          color: "#8b5cf6",
          sortOrder: 10,
          system: false,
          version: 3,
          createdAt: "2026-09-05T00:00:00Z",
          updatedAt: "2026-09-05T00:00:00Z",
        },
        capabilities: { messageReferencePropagation: true },
      };
    },
    async upsertMailTaxonomy(kind, key, request) {
      calls.push({ method: "upsertMailTaxonomy", args: [kind, key, request] });
      return {
        item: {
          id: `${kind}-${key}`,
          kind,
          name: request.name,
          ...(request.parentId ? { parentId: request.parentId } : {}),
          color: request.color ?? "#8b5cf6",
          sortOrder: 10,
          system: false,
          version: 1,
          createdAt: "2026-09-05T00:00:00Z",
          updatedAt: "2026-09-05T00:00:00Z",
        },
        capabilities: { messageReferencePropagation: true },
      };
    },
    async updateMailTaxonomy(itemId, request) {
      calls.push({ method: "updateMailTaxonomy", args: [itemId, request] });
      return {
        item: {
          id: itemId,
          kind: "folder",
          name: request.name,
          ...(request.parentId ? { parentId: request.parentId } : {}),
          color: request.color ?? "#8b5cf6",
          sortOrder: 10,
          system: false,
          version: request.expectedVersion + 1,
          createdAt: "2026-09-05T00:00:00Z",
          updatedAt: "2026-09-05T00:00:00Z",
        },
        capabilities: { messageReferencePropagation: true },
      };
    },
    async deleteMailTaxonomy(itemId, expectedVersion) {
      calls.push({ method: "deleteMailTaxonomy", args: [itemId, expectedVersion] });
      return {
        deleted: { id: itemId, changed: true },
        capabilities: { messageReferencePropagation: true },
      };
    },
    ...overrides,
  };
  return { calls, transport };
}

test("paginates folders over HTTP and maps canonical taxonomy DTOs", async () => {
  const request: MailTaxonomyListRequest = { kind: "folder" };
  let pageIndex = 0;
  const { calls, transport } = createFakeTaxonomyTransport({
    async listMailTaxonomy(query) {
      calls.push({ method: "listMailTaxonomy", args: [query] });
      pageIndex += 1;
      if (pageIndex === 1) {
        return {
          items: [
            {
              id: "folder-inbox",
              kind: "folder",
              name: "Inbox",
              color: "#7c3aed",
              sortOrder: 0,
              system: true,
              version: 1,
              createdAt: "2026-09-05T00:00:00Z",
              updatedAt: "2026-09-05T00:00:00Z",
            },
          ],
          nextCursor: "cursor-2",
          capabilities: { messageReferencePropagation: true },
        };
      }
      return {
        items: [
          {
            id: "folder-sub",
            kind: "folder",
            name: "Subfolder",
            parentId: "folder-inbox",
            color: "#06b6d4",
            sortOrder: 10,
            system: false,
            version: 1,
            createdAt: "2026-09-05T00:00:00Z",
            updatedAt: "2026-09-05T00:00:00Z",
          },
        ],
        capabilities: { messageReferencePropagation: true },
      };
    },
  });

  const result: MailTaxonomyItemDto[] =
    await createMailTaxonomyClient(transport).listMailTaxonomyItems(request);

  assert.deepEqual(result, [
    {
      id: "folder-inbox",
      kind: "folder",
      name: "Inbox",
      parent_id: null,
      color: "#7c3aed",
      sort_order: 0,
      system: true,
    },
    {
      id: "folder-sub",
      kind: "folder",
      name: "Subfolder",
      parent_id: "folder-inbox",
      color: "#06b6d4",
      sort_order: 10,
      system: false,
    },
  ]);
  assert.deepEqual(calls, [
    { method: "listMailTaxonomy", args: [{ kind: "folder", limit: 100, cursor: undefined }] },
    { method: "listMailTaxonomy", args: [{ kind: "folder", limit: 100, cursor: "cursor-2" }] },
  ]);
});

test("derives legacy-compatible slug keys and upserts folders vs labels cleanly", async () => {
  assert.equal(toMailTaxonomySlugKey("  Project Alpha! "), "project_alpha");
  assert.equal(toMailTaxonomySlugKey("中文标签"), "item");

  const folderRequest: MailTaxonomyUpsertRequest = {
    kind: "folder",
    name: "Project Alpha",
    parent_id: "folder-finance",
    color: "#06b6d4",
  };
  const labelRequest: MailTaxonomyUpsertRequest = {
    kind: "label",
    name: "VIP",
    parent_id: null,
    color: "#d9ff38",
  };
  const { calls, transport } = createFakeTaxonomyTransport();
  const client = createMailTaxonomyClient(transport);

  const folder = await client.upsertMailTaxonomyItem(folderRequest);
  const label = await client.upsertMailTaxonomyItem(labelRequest);

  assert.equal(folder.parent_id, "folder-finance");
  assert.equal(label.parent_id, null);
  assert.deepEqual(calls, [
    {
      method: "upsertMailTaxonomy",
      args: [
        "folder",
        "project_alpha",
        { name: "Project Alpha", parentId: "folder-finance", color: "#06b6d4" },
      ],
    },
    {
      method: "upsertMailTaxonomy",
      args: ["label", "vip", { name: "VIP", color: "#d9ff38" }],
    },
  ]);
});

test("updates and deletes taxonomy items using version CAS fetched from getMailTaxonomy", async () => {
  const updateReq: MailTaxonomyUpdateRequest = {
    id: "label-important",
    name: "Important",
    parent_id: null,
    color: "#d9ff38",
  };
  const deleteReq: MailTaxonomyDeleteRequest = { id: "label-important" };
  const { calls, transport } = createFakeTaxonomyTransport({
    async getMailTaxonomy(itemId) {
      calls.push({ method: "getMailTaxonomy", args: [itemId] });
      return {
        item: {
          id: itemId,
          kind: "label",
          name: "Old",
          color: "#8b5cf6",
          sortOrder: 2,
          system: false,
          version: 4,
          createdAt: "2026-09-05T00:00:00Z",
          updatedAt: "2026-09-05T00:00:00Z",
        },
        capabilities: { messageReferencePropagation: true },
      };
    },
    async updateMailTaxonomy(itemId, request) {
      calls.push({ method: "updateMailTaxonomy", args: [itemId, request] });
      return {
        item: {
          id: itemId,
          kind: "label",
          name: request.name,
          color: request.color ?? "#8b5cf6",
          sortOrder: 2,
          system: false,
          version: 5,
          createdAt: "2026-09-05T00:00:00Z",
          updatedAt: "2026-09-05T00:00:00Z",
        },
        capabilities: { messageReferencePropagation: true },
      };
    },
  });

  const client = createMailTaxonomyClient(transport);
  const updated = await client.updateMailTaxonomyItem(updateReq);
  const deleted: MailTaxonomyDeleteDto = await client.deleteMailTaxonomyItem(deleteReq);

  assert.deepEqual(updated, {
    id: "label-important",
    kind: "label",
    name: "Important",
    parent_id: null,
    color: "#d9ff38",
    sort_order: 2,
    system: false,
  });
  assert.deepEqual(deleted, { id: "label-important", changed: true });
  assert.deepEqual(calls, [
    { method: "getMailTaxonomy", args: ["label-important"] },
    {
      method: "updateMailTaxonomy",
      args: ["label-important", { expectedVersion: 4, name: "Important", color: "#d9ff38" }],
    },
    { method: "getMailTaxonomy", args: ["label-important"] },
    { method: "deleteMailTaxonomy", args: ["label-important", 4] },
  ]);
});

test("propagates HTTP transport rejections unchanged", async () => {
  const rejection = {
    code: "MAIL_TAXONOMY_PERSISTENCE_UNAVAILABLE",
    message: "Persistent mail taxonomy is not available in this runtime.",
  };
  const { transport } = createFakeTaxonomyTransport({
    async getMailTaxonomy() {
      throw rejection;
    },
  });

  await assert.rejects(
    createMailTaxonomyClient(transport).deleteMailTaxonomyItem({ id: "folder-archive" }),
    (caught: unknown) => {
      assert.strictEqual(caught, rejection);
      return true;
    },
  );
});

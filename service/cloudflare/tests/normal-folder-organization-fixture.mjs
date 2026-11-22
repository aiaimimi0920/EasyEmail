import { folderProjectionFixture, expect } from "./normal-folder-projection-fixture.mjs";

export { expect };
export async function folderOrganizationFixture(options = {}) {
  const t = await folderProjectionFixture({ testEntry: "./normal-organization-test-worker.ts", ...options });
  await t.receiveAll();
  return { ...t,
    list(kind = "messages", query = "") { const params = new URLSearchParams("sources=normal&folder=all");
      for (const [key, value] of new URLSearchParams(query)) params.set(key, value);
      return t.request(`/api/v1/${kind}?${params}`); },
    organize(name, messageIds, patch, key = crypto.randomUUID(), extra = {}) { return t.request(`${t.folderPath(name)}/messages/organize`, {
      method: "POST", headers: { "idempotency-key": key }, body: { messageIds, ...patch }, ...extra,
    }); },
    receipt(name, key, extra = {}) { return t.request(`${t.folderPath(name)}/organization-operations/${key}`, extra); },
    taxonomy(name, id, kind, extra = {}) { return t.request(`${t.folderPath(name)}/messages/${id}/${kind}`, extra); },
  };
}

import assert from "node:assert/strict";
import { createHarness } from "./runtime-harness.mjs";
import { sendFixture } from "./send-fixture.mjs";

export async function adminFixture() {
  const f = await sendFixture();
  let h;
  try {
    h = await createHarness(f.bindings);
    const admin = await h.register("operator-fixture");
    const alice = await h.register("ordinary-fixture");
    await h.db.prepare("INSERT INTO platform_admins(user_id,created_at) VALUES (?,unixepoch())").bind(admin.id).run();
    const list = () => h.request("/api/v1/admin/providers", { cookie: admin.cookie });
    const current = async (id = "self") => (await list()).body.items.find((row) => row.config.id === id);
    const save = async (changes = {}, id = "self", extra = {}) => {
      const row = await current(id);
      return h.request(`/api/v1/admin/providers/${id}`, { method: "PUT", cookie: admin.cookie,
        body: { expectedRevision: row?.revision ?? 0, config: { ...row?.config, ...changes }, secretAction: "keep", ...extra } });
    };
    const probe = (id = "self") => h.request(`/api/v1/admin/providers/${id}/probe`, { cookie: admin.cookie, method: "POST", body: {} });
    return { h, f, admin, alice, list, current, save, probe, async close() { await h.close(); await f.close(); } };
  } catch (error) { await h?.close(); await f.close(); throw error; }
}

export function ok(response, status = 200) { assert.equal(response.status, status, response.text); return response.body; }

import assert from "node:assert/strict";
import { sign } from "hono/jwt";
import { remoteFixture } from "./remote-fixture.mjs";

export const authSecret = "synthetic-address-auth-secret-32bytes-minimum";
export async function addressAuthFixture() {
  const f = await remoteFixture({ fullSchema: true, legacyAuth: true });
  const tables = ["address", "raw_mails", "raw_mail_resources", "address_sender", "sendbox", "auto_reply_mails", "users_address",
    "mail_delete_operations", "address_delete_operations"];
  return { ...f,
    async box(format = "number") {
      const address = `synthetic-${crypto.randomUUID()}@cf.example.test`;
      const row = await f.db.prepare("INSERT INTO address(name) VALUES(?) RETURNING id").bind(address).first();
      const claims = { address, address_id: format === "string" ? String(row.id) : row.id };
      return { address, id: row.id, claims, token: await sign(claims, authSecret, "HS256") };
    },
    async call(route, token, { method = "GET", body } = {}) {
      const response = await fetch(`${f.baseUrl}/api${route}`, { method, signal: AbortSignal.timeout(25000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
      return { status: response.status, body: parsed };
    },
    async replace(b) {
      await f.db.prepare("DELETE FROM address WHERE id=?").bind(b.id).run();
      return f.db.prepare("INSERT INTO address(name) VALUES(?) RETURNING id").bind(b.address).first();
    },
    async seedRelated(b) {
      await f.seed(b.address, b.id);
      await f.db.batch([
        f.db.prepare("INSERT INTO address_sender(address,balance) VALUES(?,7)").bind(b.address),
        f.db.prepare("INSERT INTO sendbox(address,raw) VALUES(?,'synthetic sent data')").bind(b.address),
        f.db.prepare("INSERT INTO auto_reply_mails(address,message) VALUES(?,'synthetic auto reply')").bind(b.address),
        f.db.prepare("INSERT INTO users_address(address_id,user_id) VALUES(?,123)").bind(b.id),
      ]);
    },
    async snapshot() {
      const state = {};
      for (const table of tables) state[table] = (await f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
      return state;
    },
    async mode(value) {
      assert.ok(["normal", "replace-before-cleanup", "fail-before-cleanup"].includes(value));
      await f.db.prepare("UPDATE fixture_auth_control SET mode=?").bind(value).run();
    },
  };
}

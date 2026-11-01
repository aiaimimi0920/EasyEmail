import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { remoteFixture } from "./remote-fixture.mjs";

test("canonical string address IDs from existing JWT issuers remain generation-bound", async () => {
  const f = await remoteFixture(); let h;
  try {
    h = await createHarness(f.bindings); const user = await h.register("address-string-claims");
    const box = (await allocate(h, user.cookie)).body.mailbox;
    const credential = await f.db.prepare("SELECT * FROM fixture_credentials WHERE address=?").bind(box.address).first();
    await f.seed(box.address, 91);
    const version = (await f.db.prepare("SELECT version FROM raw_mail_resources WHERE mail_id=91").first()).version;
    const response = await fetch(`${f.baseUrl}/api/mail_deletions`, { method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "x-custom-auth": "synthetic-site-password",
        "content-type": "application/json", "x-fixture-address-id-format": "string" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), mailId: "91", expectedVersion: version }) });
    assert.equal(response.status, 200, await response.text());
  } finally { await h?.close(); await f.close(); }
});

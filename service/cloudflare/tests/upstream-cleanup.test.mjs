import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { upstreamFixture } from "./upstream-fixture.mjs";

let f;
const tables = ["raw_mails", "sendbox", "auto_reply_mails", "address_sender"];
before(async () => { f = await upstreamFixture({ ENABLE_USER_DELETE_EMAIL: "false" }); }, { timeout: 90000 });
after(async () => { await f?.close(); }, { timeout: 20000 });
async function sample() {
  const box = await f.create(); await f.receive(box.address);
  for (const table of tables.slice(1)) await f.db.prepare(`INSERT INTO ${table}(address) VALUES(?)`).bind(box.address).run();
  await f.db.prepare("INSERT INTO users_address(user_id,address_id) VALUES(1,?)").bind(box.id).run();
  return box;
}
async function assertData(box, count) {
  for (const table of tables) {
    assert.equal(await f.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE address=?`).bind(box.address).first("n"), count, table);
  }
  assert.equal(await f.db.prepare("SELECT COUNT(*) n FROM users_address WHERE address_id=?").bind(box.id).first("n"), count);
  assert.equal(await f.db.prepare("SELECT COUNT(*) n FROM address WHERE id=?").bind(box.id).first("n"), count);
}
const remove = (box) => f.request(`/admin/delete_address/${box.id}`, { method: "DELETE", admin: true });

test("administrator deletion cleans all D1 data independently of the user-delete switch", async () => {
  const box = await sample(), other = await sample();
  assert.equal((await remove(box)).status, 200); await assertData(box, 0); await assertData(other, 1);
  assert.equal((await remove(box)).body.success, true);
});

test("administrator deletion failure rolls back mail, grants, bindings and address together", async () => {
  const box = await sample();
  await f.db.prepare("CREATE TRIGGER fail_admin_delete BEFORE DELETE ON address BEGIN SELECT RAISE(ABORT,'synthetic delete failure'); END").run();
  try { assert.equal((await remove(box)).status, 500); await assertData(box, 1); }
  finally { await f.db.prepare("DROP TRIGGER fail_admin_delete").run(); }
});

test("scheduled mailbox cleanup failure is atomic instead of leaving an emptied live mailbox", async () => {
  const box = await sample();
  await f.db.prepare("UPDATE address SET created_at=datetime('now','-20 day') WHERE id=?").bind(box.id).run();
  await f.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('auto_cleanup',?)")
    .bind(JSON.stringify({ enableAddressAutoCleanup: true, cleanAddressDays: 10 })).run();
  await f.db.prepare("CREATE TRIGGER fail_scheduled_delete BEFORE DELETE ON address BEGIN SELECT RAISE(ABORT,'synthetic cleanup failure'); END").run();
  try { assert.equal((await f.scheduled()).outcome, "exception"); await assertData(box, 1); }
  finally {
    await f.db.prepare("DROP TRIGGER fail_scheduled_delete").run();
    await f.db.prepare("DELETE FROM settings WHERE key='auto_cleanup'").run();
  }
});

test("real scheduled entry keeps fresh records, cleans old records and maintains resource triggers", async () => {
  const box = await sample(), old = await sample();
  assert.equal((await f.scheduled()).outcome, "ok"); await assertData(old, 1);
  await f.db.prepare("UPDATE raw_mails SET created_at=datetime('now','-20 day') WHERE address=?").bind(old.address).run();
  await f.db.prepare("UPDATE sendbox SET created_at=datetime('now','-20 day') WHERE address=?").bind(old.address).run();
  await f.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('auto_cleanup',?)")
    .bind(JSON.stringify({ enableMailsAutoCleanup: true, cleanMailsDays: 10, enableSendBoxAutoCleanup: true, cleanSendBoxDays: 10 })).run();
  try {
    assert.equal((await f.scheduled()).outcome, "ok"); await assertData(box, 1);
    for (const table of ["raw_mails", "sendbox"]) assert.equal(await f.db.prepare(`SELECT id FROM ${table} WHERE address=?`).bind(old.address).first(), null);
    assert.equal(await f.db.prepare("SELECT COUNT(*) n FROM raw_mail_resources v LEFT JOIN raw_mails m ON m.id=v.mail_id WHERE m.id IS NULL").first("n"), 0);
  } finally { await f.db.prepare("DELETE FROM settings WHERE key='auto_cleanup'").run(); }
});

for (const cleanType of ["inactiveAddress", "addressCreated", "unboundAddress", "emptyAddress"]) {
  test(`${cleanType} preserves its original selection rules with a bound cutoff`, async () => {
    const old = await sample(), protectedBox = await sample(), fresh = await sample();
    for (const box of [old, protectedBox]) {
      await f.db.prepare("UPDATE address SET created_at=datetime('now','-30 day'),updated_at=datetime('now','-30 day') WHERE id=?").bind(box.id).run();
    }
    if (cleanType === "inactiveAddress") {
      await f.db.prepare("UPDATE address SET updated_at=datetime('now','+1 day') WHERE id=?").bind(protectedBox.id).run();
    } else if (cleanType === "addressCreated") {
      await f.db.prepare("UPDATE address SET created_at=datetime('now','+1 day') WHERE id=?").bind(protectedBox.id).run();
    } else if (cleanType === "unboundAddress") {
      await f.db.prepare("DELETE FROM users_address WHERE address_id=?").bind(old.id).run();
    } else {
      await f.db.prepare("DELETE FROM raw_mails WHERE address=?").bind(old.address).run();
    }
    const result = await f.request("/admin/cleanup", { method: "POST", admin: true, body: { cleanType, cleanDays: 10 } });
    assert.equal(result.status, 200, result.text);
    await assertData(old, 0); await assertData(protectedBox, 1); await assertData(fresh, 1);
  });
}

test("a mailbox cleanup crossing its time boundary keeps the entire initially fresh mailbox", { timeout: 90000 }, async () => {
  const old = await sample(), boundary = await sample();
  await f.db.prepare("UPDATE address SET created_at=datetime('now','-30 day') WHERE id=?").bind(old.id).run();
  await f.db.prepare("UPDATE address SET created_at=datetime('now','+2 second') WHERE id=?").bind(boundary.id).run();
  const boundaryAt = await f.db.prepare("SELECT created_at FROM address WHERE id=?").bind(boundary.id).first("created_at");
  // A bounded real SQLite workload makes the first DELETE cross the cutoff, not a mocked clock.
  await f.db.prepare(`CREATE TRIGGER slow_cleanup_cutoff BEFORE DELETE ON raw_mails WHEN OLD.address='${old.address}' BEGIN
    SELECT sum(n) FROM (WITH RECURSIVE counter(n) AS
      (SELECT 1 UNION ALL SELECT n+1 FROM counter WHERE n<40000000) SELECT n FROM counter); END`).run();
  try {
    const result = await f.request("/admin/cleanup", { method: "POST", admin: true,
      body: { cleanType: "addressCreated", cleanDays: 0 } });
    assert.equal(result.status, 200, result.text);
    const finishedAt = await f.db.prepare("SELECT datetime('now') AS now").first("now");
    assert.ok(finishedAt > boundaryAt, "The real batch must cross the boundary to exercise cutoff drift");
    await assertData(old, 0); await assertData(boundary, 1);
    assert.equal(await f.db.prepare("SELECT COUNT(*) n FROM raw_mails m LEFT JOIN address a ON a.name=m.address WHERE a.id IS NULL").first("n"), 0);
  } finally { await f.db.prepare("DROP TRIGGER slow_cleanup_cutoff").run(); }
});

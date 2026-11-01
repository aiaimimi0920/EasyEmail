import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { PASSWORD, seedMailbox } from "./runtime-harness.mjs";
import { putLabel, labelBody, expect } from "./labels-fixture.mjs";
import { putFolder, folderBody } from "./folders-fixture.mjs";

export const button = (page, name) => page.getByRole("button", { name, exact: true });
export const combo = (page, name) => page.getByRole("combobox", { name, exact: true });
export async function mixedFixture() {
  const t = await normalAccessFixture({ browser: true });
  try {
    expect(await t.receive());
    const other = crypto.randomUUID();
    expect(await t.save({ emailAddress: "second@example.test", displayName: "第二普通邮箱", username: "Second" }, 0, t.alice.cookie, other), 201);
    expect(await t.h.request(`/api/v1/normal-accounts/${other}/sync`, { method: "POST", cookie: t.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 1 } }));
    const accounts = [t.id, other].sort(), normal = (await t.messages()).body.items[0];
    const box = await seedMailbox(t.h, t.alice.id, "temporary@example.test");
    await t.h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at)
      VALUES (?,?,?,?,?,'sender@example.test','temporary@example.test','临时批量邮件','合成测试','','[]',?,?)`)
      .bind(normal.id, t.alice.id, box, normal.id, normal.id, normal.receivedAt, normal.receivedAt).run();
    const label = crypto.randomUUID(), folder = crypto.randomUUID();
    expect(await putLabel(t.h, t.alice, label, labelBody("批量标签")), 201);
    expect(await putFolder(t.h, t.alice, folder, folderBody("批量位置")), 201);
    const rows = await t.h.db.prepare("SELECT id,email_address FROM normal_accounts WHERE user_id=? ORDER BY id").bind(t.alice.id).all();
    return { ...t, accounts, box, label, folder, collisionId: normal.id, addresses: Object.fromEntries(rows.results.map(row => [row.id, row.email_address])) };
  } catch (failure) { await t.close(); throw failure; }
}
export async function openMixed(t, count = 5) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000);
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
    await page.getByRole("navigation").getByRole("button", { name: "聚合收件箱", exact: true }).click();
    const inbox = page.getByRole("region", { name: "聚合邮件", exact: true });
    await inbox.getByRole("status").filter({ hasText: `已加载 ${count} 封` }).waitFor();
    return { browser, page, inbox };
  } catch (failure) { await browser.close(); throw failure; }
}
export const completed = (page, count) => page.getByRole("status").filter({ hasText: `已完成 ${count} 封；` }).waitFor();
export function captureWrites(page) {
  const writes = [];
  page.on("request", request => { if (request.method() === "POST" && /\/messages\/organize$/.test(request.url())) {
    writes.push({ path: new URL(request.url()).pathname, key: request.headers()["idempotency-key"], body: request.postDataJSON() });
  } });
  return writes;
}
export async function assertPlatformOnly(t, page) {
  assert.equal(t.opens.length, 2); assert.equal(t.calls.some(line => /STORE|EXPUNGE|COPY|MOVE/.test(line)), false);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
}

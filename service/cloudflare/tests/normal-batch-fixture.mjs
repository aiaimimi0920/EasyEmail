import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { PASSWORD } from "./runtime-harness.mjs";
import { putLabel, labelBody, expect } from "./labels-fixture.mjs";
import { putFolder, folderBody } from "./folders-fixture.mjs";

export const button = (page, name) => page.getByRole("button", { name, exact: true });
export const combo = (page, name) => page.getByRole("combobox", { name, exact: true });
export async function normalBatchFixture() {
  const t = await normalAccessFixture({ browser: true });
  try {
    expect(await t.receive()); const label = crypto.randomUUID(), folder = crypto.randomUUID();
    expect(await putLabel(t.h, t.alice, label, labelBody("批量标签")), 201);
    expect(await putFolder(t.h, t.alice, folder, folderBody("批量位置")), 201);
    return { ...t, label, folder };
  } catch (failure) { await t.close(); throw failure; }
}
export async function openNormalBatch(t, prepare = async () => {}) {
  const browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(10000); await prepare(page);
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await button(page, "登录").click();
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    const normal = page.getByRole("region", { name: "普通邮箱", exact: true }); await button(normal, "普通邮箱").click();
    const inbox = normal.getByRole("region", { name: "普通邮箱收件", exact: true });
    await button(inbox, "收件验收").first().waitFor(); return { browser, page, normal, inbox };
  } catch (failure) { await browser.close(); throw failure; }
}
export const selection = (inbox, count) => inbox.getByRole("status").filter({ hasText: `已选择 ${count} 封（` }).waitFor();
export function captureNormalWrites(page) {
  const writes = [];
  page.on("request", request => { if (request.method() === "POST" && /\/messages\/organize$/.test(request.url())) {
    writes.push({ path: new URL(request.url()).pathname, key: request.headers()["idempotency-key"], body: request.postDataJSON() });
  } }); return writes;
}
export async function assertNormalPlatformOnly(t, page) {
  assert.equal(t.opens.length, 1); assert.equal(t.calls.some(line => /STORE|EXPUNGE|COPY|MOVE/.test(line)), false);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
}

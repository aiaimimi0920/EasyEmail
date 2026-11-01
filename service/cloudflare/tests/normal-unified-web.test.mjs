import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { RAW_MESSAGE } from "./normal-read-fixture.mjs";
import { ATTACHMENT, multipartMessage } from "./normal-mime-fixture.mjs";
import { PASSWORD, seedMailbox } from "./runtime-harness.mjs";

test("Chrome: unified ordinary search opens the protected reader, exact downloads and shared cached OTP with no IMAP side effects", { timeout: 240000 }, async () => {
  const t = await normalAccessFixture({ browser: true, messages: new Map([[1, RAW_MESSAGE], [2, multipartMessage()]]), uidNext: 3 });
  let browser, page;
  const started = Date.now(), phase = name => console.log(`Unified Chrome ${Date.now() - started}ms: ${name}`);
  try {
    assert.equal((await t.receive()).body.request.state, "committed");
    phase("normal receive committed");
    const box = await seedMailbox(t.h, t.alice.id, "temporary@example.test"), id = crypto.randomUUID();
    await t.h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at)
      VALUES (?,?,?,?,?,'temp@example.test','temporary@example.test','Temporary unified','temporary marker','','[]',1,1)`)
      .bind(id, t.alice.id, box, id, id).run();
    browser = await chromium.launch({ executablePath: process.env.EASYEMAIL_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); page.setDefaultTimeout(15000);
    const errors = [], external = [], wrong = [];
    page.on("pageerror", error => errors.push(error.message)); page.on("request", request => {
      if (!request.url().startsWith(t.h.baseUrl.origin)) external.push(request.url());
      if (request.method() !== "GET" && /\/messages|\/outgoing/.test(request.url())) wrong.push(request.url());
    });
    await page.goto(t.h.baseUrl.href); await page.getByLabel("用户名", { exact: true }).fill(t.alice.username);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "聚合收件箱", exact: true }).click();
    const region = page.getByRole("region", { name: "聚合邮件", exact: true });
    await region.getByRole("status").filter({ hasText: "已加载 3 封" }).waitFor();
    phase("mixed timeline loaded");
    assert.equal(await region.getByRole("checkbox").count(), 3, "mixed-source selection is available without performing any mutation");
    assert.equal(await region.getByRole("checkbox", { checked: true }).count(), 0);
    await region.getByLabel("搜索缓存邮件", { exact: true }).fill("742951"); await region.getByRole("button", { name: "搜索邮件", exact: true }).click();
    await region.getByRole("button", { name: "收件验收", exact: true }).click();
    let detail = region.getByRole("region", { name: "普通邮件详情", exact: true }); await detail.getByText("验证码 742951", { exact: false }).waitFor();
    assert.equal(await detail.getByRole("button", { name: "回复", exact: true }).count(), 1);
    for (const [search, button, expected, filename] of [["742951", "下载原始邮件", RAW_MESSAGE, "unified-raw.eml"], ["attachments", "下载 part-0.bin", ATTACHMENT, "unified-attachment.bin"]]) {
      await region.getByLabel("搜索缓存邮件", { exact: true }).fill(search); await region.getByRole("button", { name: "搜索邮件", exact: true }).click();
      await region.getByRole("button", { name: search === "742951" ? "收件验收" : "attachments", exact: true }).click();
      detail = region.getByRole("region", { name: "普通邮件详情", exact: true });
      const event = page.waitForEvent("download"); await detail.getByRole("button", { name: button, exact: true }).click();
      const download = await event, target = path.join(t.h.directory, filename); phase(`download event ${filename}`);
      await download.saveAs(target); phase(`saved ${filename}`); assert.deepEqual(await readFile(target), Buffer.from(expected)); phase(`bytes verified ${filename}`);
    }
    await region.getByRole("combobox", { name: "邮件来源", exact: true }).selectOption("temporary"); await region.getByLabel("搜索缓存邮件", { exact: true }).fill("");
    await region.getByRole("button", { name: "搜索邮件", exact: true }).click(); await region.getByRole("button", { name: "Temporary unified", exact: true }).waitFor();
    phase("temporary source selected");
    assert.equal(await region.getByRole("button", { name: "attachments", exact: true }).count(), 0);
    await page.getByRole("navigation").getByRole("button", { name: "普通邮箱", exact: true }).click();
    const normal = page.getByRole("region", { name: "普通邮箱", exact: true }); await normal.getByRole("button", { name: "普通邮箱", exact: true }).click();
    await normal.getByLabel("缓存收件时间起点", { exact: true }).fill("2026-10-29T00:00");
    await normal.getByRole("button", { name: "提取缓存邮件", exact: true }).click(); await normal.getByTestId("otp-code").filter({ hasText: "742951" }).waitFor();
    phase("cached OTP shown");
    await page.getByLabel("名称", { exact: true }).fill("unified-download-profile");
    await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("unified-download");
    await page.getByRole("button", { name: "创建 Key", exact: true }).click();
    const token = await page.getByTestId("new-key").textContent(); assert.match(token, /^ee_[a-f0-9]{64}$/);
    const independent = await t.h.request("/api/v1/messages?sources=all", { token, origin: null });
    assert.equal(independent.status, 200, independent.text); assert.equal(independent.body.items.length, 3);
    assert.equal((await t.h.request(`${t.base}/messages`, { token, origin: null })).status, 200);
    assert.equal((await t.h.request(`${t.base}/sync`, { method: "POST", token, origin: null, body: {} })).status, 403);
    await page.getByRole("button", { name: "隐藏", exact: true }).click(); phase("independent API Key scope verified");
    assert.equal(await normal.getByRole("button", { name: "等待新结果（60 秒）", exact: true }).count(), 0);
    assert.equal(t.opens.length, 1); assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(wrong, []);
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole("navigation").getByRole("button", { name: "聚合收件箱", exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(t.h.directory, "normal-unified-mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); console.log(`Unified normal Chrome evidence: ${t.h.directory}`);
  } catch (error) {
    if (page) { await page.getByTestId("new-key").evaluate(element => { element.textContent = "[redacted]"; }).catch(() => {});
      console.error(await page.locator("body").ariaSnapshot()); await page.screenshot({ path: path.join(t.h.directory, "normal-unified-failure.png"), fullPage: true }); } throw error;
  } finally { await browser?.close(); await t.close(); }
});

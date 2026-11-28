import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createHarness, PASSWORD } from "./runtime-harness.mjs";
import { allocate, cfMail, providerFixture } from "./provider-fixture.mjs";

const KEYRING = JSON.stringify({
  active: "k1",
  keys: { k1: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
});

test(
  "Chrome: Omnimail Neuro UI workbench panels, inbound auto-rules, fidelity paper reader, and contact candidate mining",
  { timeout: 120000 },
  async () => {
    const fixture = await providerFixture();
    let h, browser, page;
    try {
      h = await createHarness({ ...fixture.bindings, MAILBOX_KEYRING: KEYRING }, true);
      const user = await h.register("omnimail-web-alice");
      const box = (await allocate(h, user.cookie)).body.mailbox;

      browser = await chromium.launch({
        executablePath:
          process.env.EASYEMAIL_CHROME_PATH ??
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
        headless: true,
      });
      page = await browser.newPage({ viewport: { width: 1360, height: 960 } });
      page.setDefaultTimeout(10000);
      const errors = [];
      const cspErrors = [];
      const external = [];
      page.on("pageerror", (err) => errors.push(err.message));
      page.on("console", (msg) => {
        if (msg.type() === "error" && /Content Security Policy/i.test(msg.text())) {
          cspErrors.push(msg.text());
        }
      });
      page.on("request", (req) => {
        const url = req.url();
        if (!url.startsWith(h.baseUrl.origin) && !url.startsWith("blob:") && !url.startsWith("data:")) {
          external.push(url);
        }
      });

      await page.goto(h.baseUrl.href);
      await page.getByLabel("用户名", { exact: true }).fill(user.username);
      await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      const nav = page.getByRole("navigation", { name: "邮件工作台", exact: true });
      await nav.waitFor();

      // 1. Create an active inbound rule via @neuro/ui InboxRulesPanel
      await nav.getByRole("button", { name: "收件规则", exact: true }).click();
      await page.getByRole("heading", { name: "多条件收件规则与 30 天只读 Dry-Run 预览", exact: true }).waitFor();
      await page.getByLabel("规则名称", { exact: true }).fill("自动已读通知");
      await page.getByLabel("匹配值", { exact: true }).fill("example.test");
      await page.getByRole("button", { name: "新增收件规则", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "已保存收件规则" }).waitFor();

      // 2. Deliver HTML mail -> verify inbound auto-rule marked it read on sync + test Fidelity Paper Light mode
      const mail = cfMail(
        box.address,
        1,
        "Hello from Ada Lovelace.",
        new Date().toISOString().slice(0, 19).replace("T", " "),
      );
      mail.sender = "Ada Lovelace <ada@example.test>";
      mail.subject = "Styled Newsletter";
      mail.html =
        '<style>.card{padding:12px;border:1px solid #cbd5e1}</style><div class="card" style="background: url(https://cdn.example.invalid/bg.png)"><h2>Analytical Engine</h2><p>Fidelity layout preserved.</p><img src="https://cdn.example.invalid/banner.png" width="320" height="120" alt="Banner"><img src="https://cdn.example.invalid/unbalanced.png" alt="unclosed><img src="https://track.example.invalid/open.gif" width="1" height="1"></div>';
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
        0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
        0x42, 0x60, 0x82,
      ]);
      const corruptBytes = Buffer.from("not-a-valid-png-payload");
      const cryptoMod = await import("node:crypto");
      const pngSha = cryptoMod.createHash("sha256").update(pngBytes).digest("hex");
      const corruptSha = cryptoMod.createHash("sha256").update(corruptBytes).digest("hex");
      mail.attachments = [
        { filename: "badge.png", mimeType: "image/png", size: pngBytes.length, index: 0, sha256: pngSha },
        { filename: "corrupt.png", mimeType: "image/png", size: corruptBytes.length, index: 1, sha256: corruptSha },
      ];
      const rawMimeWithPng = [
        `From: ${mail.sender}`,
        `To: ${box.address}`,
        `Subject: ${mail.subject}`,
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="omni-web-mix"',
        "",
        "--omni-web-mix",
        "Content-Type: text/plain; charset=utf-8",
        "",
        mail.text,
        "--omni-web-mix",
        "Content-Type: image/png",
        'Content-Disposition: attachment; filename="badge.png"',
        "Content-Transfer-Encoding: base64",
        "",
        pngBytes.toString("base64"),
        "--omni-web-mix",
        "Content-Type: image/png",
        'Content-Disposition: attachment; filename="corrupt.png"',
        "Content-Transfer-Encoding: base64",
        "",
        corruptBytes.toString("base64"),
        "--omni-web-mix--",
        "",
      ].join("\r\n");
      fixture.messages.set(box.address, [mail]);
      fixture.rawMails.set(box.address, [{ id: mail.id, address: box.address, raw: rawMimeWithPng }]);

      await nav.getByRole("button", { name: "邮箱管理", exact: true }).click();
      await page.getByRole("button", { name: box.address, exact: true }).click();
      await page.getByRole("button", { name: "刷新收信", exact: true }).click();
      await page.getByRole("button", { name: "Styled Newsletter", exact: true }).click();
      await page.getByTestId("mail-body").waitFor();

      const msgRow = await h.db
        .prepare("SELECT is_read FROM messages WHERE mailbox_id = ?")
        .bind(box.id)
        .first();
      assert.equal(msgRow.is_read, 1, "Inbound auto-rule must mark matching new message as read on sync");

      await page.getByRole("button", { name: "保真排版", exact: true }).click();
      await page.getByRole("button", { name: "柔和纸张浅底", exact: true }).click();
      await page.getByRole("region", { name: "远程图片与追踪防护", exact: true })
        .getByText(/隐私保护：已默认拦截 3 项远程图片资源及 1 个疑似追踪像素/).waitFor();
      const frame = page.frameLocator('iframe[title="安全邮件正文"]');
      await frame.getByRole("heading", { name: "Analytical Engine" }).waitFor();
      assert.equal(
        await frame.locator('img[alt="Banner"]').getAttribute("data-ee-remote-src"),
        "https://cdn.example.invalid/banner.png",
      );
      assert.equal(await frame.locator('img[alt="Banner"]').getAttribute("src"), null);
      assert.equal(await frame.locator('img[src^="http"]').count(), 0);
      assert.equal(await frame.locator('img[data-ee-tracking-blocked="1"]').count(), 1);
      const styleText = await frame.locator("style").textContent();
      assert.match(styleText, /#F5F2EB/);
      assert.equal(styleText.includes("#000000"), false);

      // Attachment error feedback in real MessageDetail entry point before valid lightbox preview
      const previewBtn = page.getByRole("button", { name: "预览 badge.png", exact: true });
      const downloadBtn = page.getByRole("button", { name: "下载 badge.png", exact: true });
      await previewBtn.scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.route("**/attachments/0", (route) =>
        route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "attachment_source_changed" } }),
        }),
      );
      await previewBtn.click();
      await page.getByRole("alert").filter({ hasText: /附件源已变化/ }).waitFor();
      assert.equal(await page.getByRole("region", { name: "图片预览：badge.png", exact: true }).count(), 0);
      await page.unroute("**/attachments/0");

      await page.route("**/attachments/0", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/plain",
          headers: { "content-length": String(pngBytes.length) },
          body: pngBytes,
        }),
      );
      await downloadBtn.click();
      await page.getByRole("alert").filter({ hasText: /附件响应格式或声明大小未通过安全核验/ }).waitFor();
      await page.unroute("**/attachments/0");

      await page.route("**/attachments/0", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/octet-stream",
          headers: { "content-length": "5" },
          body: Buffer.from("short"),
        }),
      );
      await downloadBtn.click();
      await page.getByRole("alert").filter({ hasText: /附件实际字节数与缓存元数据不一致/ }).waitFor();
      await page.unroute("**/attachments/0");

      // Attachment verification status feedback on image lightbox preview
      await previewBtn.click();
      await page.getByRole("status").filter({ hasText: /已核验附件完整性和大小：badge\.png/ }).waitFor();
      const previewSection = page.getByRole("region", { name: "图片预览：badge.png", exact: true });
      await previewSection.waitFor();
      const previewImg = previewSection.locator('img[alt="badge.png"]');
      await previewImg.waitFor();
      await page.waitForFunction(() => {
        const img = document.querySelector('section[aria-label="图片预览：badge.png"] img[alt="badge.png"]');
        return img instanceof HTMLImageElement && img.complete && img.naturalWidth === 1;
      });
      await page.getByRole("button", { name: "关闭预览", exact: true }).click();

      // Corrupt image payload passes byte/hash verification then surfaces decode error alert in Lightbox
      const corruptPreviewBtn = page.getByRole("button", { name: "预览 corrupt.png", exact: true });
      await corruptPreviewBtn.scrollIntoViewIfNeeded();
      await corruptPreviewBtn.click();
      await page.getByRole("alert").filter({ hasText: /图片内容无法解码/ }).waitFor();
      await page.getByRole("button", { name: "关闭预览", exact: true }).click();

      // 3. Contact candidate extraction from recent incoming mail -> 1-click add to Contacts
      await nav.getByRole("button", { name: "联系人", exact: true }).click();
      await page.getByText("联系人去重合并、近期发件人提取与 vCard 导入／导出").click();
      await page.getByRole("button", { name: "从近期收件提取候选联系人", exact: true }).click();
      await page.getByText("Ada Lovelace (ada@example.test)").waitFor();
      await page.getByRole("button", { name: "加入通讯录", exact: true }).click();
      const savedContact = await h.db
        .prepare("SELECT email_address FROM contacts WHERE user_id = ? AND deleted_at IS NULL")
        .bind(user.id)
        .first();
      assert.equal(savedContact.email_address, "ada@example.test");

      // 4. AI Settings & WorkBuddy panels render cleanly with @neuro/ui and responsive 390px layout
      await nav.getByRole("button", { name: "AI 与翻译设置", exact: true }).click();
      await page.getByRole("region", { name: "AI 与翻译设置", exact: true }).waitFor();

      await nav.getByRole("button", { name: "WorkBuddy 邮箱", exact: true }).click();
      await page.getByRole("region", { name: "WorkBuddy 智能体邮箱", exact: true }).waitFor();

      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({ path: path.join(h.directory, "omnimail-web-mobile.png"), fullPage: true });
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(cspErrors, []);
      assert.deepEqual(external, []);
    } catch (error) {
      if (page) {
        console.error(await page.locator("body").ariaSnapshot());
        await page.screenshot({ path: path.join(h.directory, "omnimail-web-failure.png"), fullPage: true });
      }
      throw error;
    } finally {
      await browser?.close();
      await h?.close();
      await fixture.close();
    }
  },
);

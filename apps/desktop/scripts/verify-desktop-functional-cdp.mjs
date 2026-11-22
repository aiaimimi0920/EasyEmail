import fs from "node:fs";
import path from "node:path";

import { chromium } from "playwright-core";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const endpoint = argument("--endpoint");
const dataDir = argument("--data-dir");
const timeoutMs = Number(argument("--timeout-ms", "120000"));
if (!endpoint || !dataDir || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("Usage: node verify-desktop-functional-cdp.mjs --endpoint URL --data-dir PATH [--timeout-ms MS]");
}

function requestPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

async function waitForCdp() {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
      lastError = new Error(`CDP discovery returned HTTP ${response.status}.`);
    } catch (caught) {
      lastError = caught;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`WebView2 CDP endpoint did not become ready: ${String(lastError)}`);
}

async function waitForTauriPage(browser) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("http://tauri.localhost"));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The packaged desktop WebView did not navigate to the Tauri origin.");
}

async function waitForPersistedSession(sessionId, expectedStatus = null) {
  const statePath = path.join(dataDir, "core", "state", "easy-email-state.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const session = Array.isArray(state.sessions)
        ? state.sessions.find((candidate) => candidate.id === sessionId)
        : null;
      if (session && (!expectedStatus || session.status === expectedStatus)) {
        return { sessionCount: state.sessions.length, status: session.status };
      }
    } catch {
      // The host writes the state atomically; retry until the completed file is visible.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    expectedStatus
      ? `The temporary mailbox did not persist status ${expectedStatus}.`
      : "The created temporary mailbox was not persisted in the isolated core state.",
  );
}

await waitForCdp();
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = await waitForTauriPage(browser);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.locator('main[data-view="mail"]').waitFor({ state: "visible", timeout: timeoutMs });
  await page.getByRole("search").waitFor({ state: "visible" });
  console.log("PACKAGED_UI_LOADED=True");

  const rail = page.locator(".nt-side-rail");
  const titlebar = page.locator(".nt-app-titlebar");
  const pageHeader = page.locator(".nt-workspace-page-header");
  const listPane = page.locator(".nt-list-pane");
  const readingPane = page.locator(".nt-reading-pane");
  const [railBox, titlebarBox, pageHeaderBox, listBox, readingBox] = await Promise.all(
    [rail, titlebar, pageHeader, listPane, readingPane].map((locator) => locator.boundingBox()),
  );
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  if (Math.abs(viewport.width - 1120) > 2 || Math.abs(viewport.height - 760) > 2) {
    throw new Error(`Desktop viewport does not match Loom: ${JSON.stringify(viewport)}.`);
  }
  if (!railBox || Math.abs(railBox.width - 186) > 1) {
    throw new Error(`Expanded rail has unexpected geometry: ${JSON.stringify(railBox)}.`);
  }
  if (!titlebarBox || Math.abs(titlebarBox.height - 50) > 1 || titlebarBox.x < 185) {
    throw new Error(`Desktop titlebar has unexpected geometry: ${JSON.stringify(titlebarBox)}.`);
  }
  if (
    !pageHeaderBox
    || Math.abs(pageHeaderBox.x - 186) > 1
    || Math.abs(pageHeaderBox.y - 50) > 1
    || Math.abs(pageHeaderBox.width - (viewport.width - 186)) > 2
    || Math.abs(pageHeaderBox.height - 86) > 1
  ) {
    throw new Error(`Workspace page header has unexpected geometry: ${JSON.stringify(pageHeaderBox)}.`);
  }
  if (!listBox || !readingBox || listBox.x >= readingBox.x || listBox.width < 259) {
    throw new Error("Mail list and reading panes did not render as separate columns.");
  }
  for (const label of ["最小化", "最大化或还原", "关闭"]) {
    await page.getByRole("button", { name: label, exact: true }).waitFor({ state: "visible" });
  }
  await page.getByRole("button", { name: "设置", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: /^账号：/ }).waitFor({ state: "visible" });
  const redundantChromeText = await page.locator([
    ".nt-app-titlebar__drag-region span",
    ".nt-workspace-page-header__meta",
    ".nt-workspace-page-header__copy > span",
    ".nt-mail-source-selector__kicker",
    ".nt-mail-list-toolbar__mailbox-title",
  ].join(", ")).count();
  if (redundantChromeText !== 0) {
    throw new Error(`Desktop chrome still renders ${redundantChromeText} redundant context labels.`);
  }
  await page.getByRole("button", { name: "收起侧栏" }).click();
  await page.waitForFunction(() => {
    const collapsedRail = document.querySelector(".nt-side-rail");
    return collapsedRail && Math.abs(collapsedRail.getBoundingClientRect().width - 52) < 1;
  });
  await page.getByRole("button", { name: "展开侧栏" }).click();
  await page.waitForFunction(() => {
    const expandedRail = document.querySelector(".nt-side-rail");
    return expandedRail && Math.abs(expandedRail.getBoundingClientRect().width - 186) < 1;
  });
  console.log("LOOM_DESKTOP_CHROME_UI=True");
  console.log("MAIL_MULTI_COLUMN_UI=True");

  for (const railItem of [
    "inbox",
    "drafts",
    "sent",
    "starred",
    "archive",
    "spam",
    "trash",
    "all-mail",
    "newsletters",
    "inbox",
  ]) {
    await page.locator(`[data-mail-rail-item="${railItem}"]`).click();
  }
  console.log("NAVIGATION_UI=True");

  const searchInput = page.getByRole("textbox", { name: "搜索邮件" });
  await searchInput.fill("functional smoke");
  if (await searchInput.inputValue() !== "functional smoke") {
    throw new Error("Mail search did not retain the entered query.");
  }
  await page.getByRole("button", { name: "清空搜索" }).click();
  if (await searchInput.inputValue() !== "") {
    throw new Error("Mail search did not clear its query.");
  }
  const codesOnlyButton = page.getByRole("button", { name: "仅显示包含验证码的邮件" });
  await codesOnlyButton.click();
  if (await codesOnlyButton.getAttribute("aria-pressed") !== "true") {
    throw new Error("Verification-code filtering did not become active.");
  }
  await codesOnlyButton.click();
  await page.keyboard.press("Escape");
  console.log("SEARCH_UI=True");

  await page.locator('[data-mail-rail-item="compose"]').click();
  const composeDialog = page.getByRole("dialog", { name: "写邮件" });
  await composeDialog.waitFor({ state: "visible" });
  await composeDialog.getByPlaceholder("主题").fill("Functional smoke draft");
  const composeBody = composeDialog.getByRole("textbox", { name: "邮件正文" });
  await composeBody.fill("Local draft body");
  await composeDialog.getByRole("button", { name: "删除草稿" }).click();
  if (await composeDialog.getByPlaceholder("主题").inputValue() !== "") {
    throw new Error("Deleting the draft did not clear its subject.");
  }
  if ((await composeBody.textContent())?.trim()) {
    throw new Error("Deleting the draft did not clear its body.");
  }
  await composeDialog.getByRole("button", { name: "关闭写信窗口" }).click();
  await composeDialog.waitFor({ state: "hidden" });
  console.log("COMPOSE_UI=True");

  await page.locator('button[data-view="setup"]').click();
  const settingsShell = page.locator('main[data-view="setup"]');
  await settingsShell.waitFor({ state: "visible" });
  await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
  const settingsPage = settingsShell.locator(".nt-settings-page");
  const settingsColumns = settingsPage.locator(":scope > .nt-two-column");
  await settingsColumns.waitFor({ state: "visible" });
  const [settingsShellBox, settingsPageBox, settingsColumnsBox] = await Promise.all([
    settingsShell.boundingBox(),
    settingsPage.boundingBox(),
    settingsColumns.boundingBox(),
  ]);
  if (!settingsShellBox || !settingsPageBox || !settingsColumnsBox) {
    throw new Error("Settings workspace geometry could not be measured.");
  }
  const expectedSettingsHeight = settingsShellBox.height - 50;
  if (Math.abs(settingsPageBox.height - expectedSettingsHeight) > 4) {
    throw new Error(
      `Settings page was clipped: expected about ${expectedSettingsHeight}px, got ${settingsPageBox.height}px.`,
    );
  }
  if (settingsColumnsBox.y >= settingsPageBox.y + settingsPageBox.height) {
    throw new Error("Settings columns are outside the visible settings workspace.");
  }
  await page.locator('[data-mail-rail-item="inbox"]').click();
  await page.locator('main[data-view="mail"]').waitFor({ state: "visible" });
  console.log("SETTINGS_UI=True");

  const sourceSelector = page.getByRole("button", { name: "选择当前邮箱账号" });
  await sourceSelector.click();
  await page.getByRole("button", { name: "添加长效邮箱", exact: true }).click();
  const accountDialog = page.getByRole("dialog", { name: "添加长效邮箱" });
  await accountDialog.waitFor({ state: "visible" });
  let accountCreateRequestCount = 0;
  const countAccountCreateRequest = (request) => {
    if (requestPath(request.url()) === "/mail/accounts" && request.method() === "POST") {
      accountCreateRequestCount += 1;
    }
  };
  page.on("request", countAccountCreateRequest);
  await accountDialog.getByRole("button", { name: "保存并测试 IMAP" }).click();
  await page.getByRole("alert").filter({
    hasText: "Enter a valid mailbox email address.",
  }).waitFor({ state: "visible" });
  await page.waitForTimeout(100);
  page.off("request", countAccountCreateRequest);
  if (accountCreateRequestCount !== 0) {
    throw new Error("Invalid IMAP account input reached the credential or HTTP create flow.");
  }
  await accountDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await accountDialog.waitFor({ state: "hidden" });
  console.log("MAIL_ACCOUNT_PANEL_UI=True");
  console.log("MAIL_ACCOUNT_VALIDATION_UI=True");

  await sourceSelector.click();
  const requiredRefreshPaths = [
    "/mail/query/mailbox-sessions",
    "/mail/query/provider-instances",
    "/mail/query/observed-messages",
    "/mail/accounts",
  ];
  const postCreateResponsePromises = requiredRefreshPaths.map((requiredPath) =>
    page.waitForResponse(
      (response) => requestPath(response.url()) === requiredPath,
      { timeout: timeoutMs },
    ),
  );
  const openResponsePromise = page.waitForResponse(
    (response) => requestPath(response.url()) === "/mail/mailboxes/open" && response.request().method() === "POST",
    { timeout: timeoutMs },
  );
  await page.getByRole("button", { name: "创建并添加临时邮箱", exact: true }).click();
  const openResponse = await openResponsePromise;
  if (openResponse.status() !== 200) {
    throw new Error(`Temporary mailbox creation returned HTTP ${openResponse.status()}.`);
  }
  const openBody = await openResponse.json();
  const createdSessionId = openBody?.result?.session?.id;
  const createdEmailAddress = openBody?.result?.session?.emailAddress;
  if (typeof createdSessionId !== "string" || !createdSessionId) {
    throw new Error("Temporary mailbox creation returned no session ID.");
  }
  if (typeof createdEmailAddress !== "string" || !createdEmailAddress) {
    throw new Error("Temporary mailbox creation returned no email address.");
  }

  const selectedSourceLabel = sourceSelector.locator("strong");
  await selectedSourceLabel.filter({ hasText: createdEmailAddress }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  if ((await selectedSourceLabel.textContent())?.trim() !== createdEmailAddress) {
    throw new Error("The created temporary mailbox was not selected as the current inbox source.");
  }
  await sourceSelector.click();
  const createdSourceOption = page.getByRole("option", {
    name: createdEmailAddress,
    exact: true,
  });
  await createdSourceOption.waitFor({ state: "visible", timeout: timeoutMs });
  if ((await createdSourceOption.getAttribute("aria-selected")) !== "true") {
    throw new Error("The created temporary mailbox source is visible but not selected.");
  }
  await sourceSelector.click();
  const postCreateResponses = await Promise.all(postCreateResponsePromises);
  for (const [index, response] of postCreateResponses.entries()) {
    if (response.status() !== 200) {
      throw new Error(
        `Post-create refresh returned HTTP ${response.status()}: ${requiredRefreshPaths[index]}.`,
      );
    }
  }
  const persistedSession = await waitForPersistedSession(createdSessionId);
  console.log("TEMP_MAILBOX_CREATE_HTTP=200");
  console.log("TEMP_MAILBOX_CREATE_UI=True");
  console.log(`TEMP_MAILBOX_PERSISTED_SESSIONS=${persistedSession.sessionCount}`);

  const refreshResponsePromise = page.waitForResponse(
    (response) => requestPath(response.url()) === "/mail/mailboxes/anonymous/refresh" && response.request().method() === "POST",
    { timeout: timeoutMs },
  );
  await page.getByRole("button", { name: "同步当前邮箱" }).click();
  const refreshResponse = await refreshResponsePromise;
  if (refreshResponse.status() !== 200) {
    throw new Error(`Temporary mailbox sync returned HTTP ${refreshResponse.status()}.`);
  }
  console.log("TEMP_MAILBOX_SYNC_HTTP=200");
  console.log("TEMP_MAILBOX_SYNC_UI=True");

  await page.locator('button[data-view="setup"]').click();
  await page.locator('main[data-view="setup"]').waitFor({ state: "visible" });
  const releaseResponsePromise = page.waitForResponse(
    (response) => requestPath(response.url()) === "/mail/mailboxes/release"
      && response.request().method() === "POST",
    { timeout: timeoutMs },
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Release mailbox" }).click();
  const releaseResponse = await releaseResponsePromise;
  if (releaseResponse.status() !== 200) {
    throw new Error(`Temporary mailbox release returned HTTP ${releaseResponse.status()}.`);
  }
  const releaseBody = await releaseResponse.json();
  if (releaseBody?.result?.session?.status !== "expired") {
    throw new Error("Temporary mailbox release did not close the active core session.");
  }
  await page.getByLabel("Temporary mailbox").locator(
    `option[value="${createdSessionId}"]`,
  ).filter({ hasText: "(expired)" }).waitFor({ state: "attached", timeout: timeoutMs });
  const releasedSession = await waitForPersistedSession(createdSessionId, "expired");
  console.log("TEMP_MAILBOX_RELEASE_HTTP=200");
  console.log("TEMP_MAILBOX_RELEASE_UI=True");
  console.log(`TEMP_MAILBOX_RELEASE_STATE=${releasedSession.status}`);

  if (pageErrors.length > 0) {
    throw new Error(`The packaged WebView raised page errors: ${pageErrors.join(" | ")}`);
  }
  console.log("WEBVIEW_PAGE_ERRORS=0");
} finally {
  await browser.close();
}

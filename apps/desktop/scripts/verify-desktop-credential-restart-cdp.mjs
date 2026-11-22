import fs from "node:fs";

import { chromium } from "playwright-core";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const endpoint = argument("--endpoint");
const phase = argument("--phase");
const metadataFile = argument("--metadata-file");
const imapPort = Number(argument("--imap-port", "0"));
const timeoutMs = Number(argument("--timeout-ms", "90000"));
if (!endpoint || !phase || !metadataFile || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("Invalid arguments for verify-desktop-credential-restart-cdp.mjs.");
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
      lastError = new Error(`CDP HTTP ${response.status}`);
    } catch (caught) {
      lastError = caught;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`WebView2 CDP endpoint did not become ready: ${String(lastError)}`);
}

async function waitForTauriPage(browser) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = browser.contexts().flatMap((ctx) => ctx.pages())
      .find((candidate) => candidate.url().startsWith("http://tauri.localhost"));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Packaged WebView did not navigate to http://tauri.localhost.");
}

await waitForCdp();
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = await waitForTauriPage(browser);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.locator('main[data-view="mail"]').waitFor({ state: "visible", timeout: timeoutMs });
  await page.locator('button[data-view="setup"]').click();
  const settingsShell = page.locator('main[data-view="setup"]');
  await settingsShell.waitFor({ state: "visible", timeout: timeoutMs });
  const mailAccountBoard = settingsShell.locator("section.nt-action-board").filter({ hasText: "MAIL ACCOUNT" });
  await mailAccountBoard.waitFor({ state: "visible", timeout: timeoutMs });

  if (phase === "run1-create-and-test") {
    const canarySecret = process.env.EASYEMAIL_SMOKE_CANARY_SECRET;
    if (!canarySecret || !Number.isSafeInteger(imapPort) || imapPort <= 0) {
      throw new Error("run1-create-and-test requires EASYEMAIL_SMOKE_CANARY_SECRET and --imap-port.");
    }

    await mailAccountBoard.getByLabel("Display name").fill("Smoke Restart IMAP");
    await mailAccountBoard.getByLabel("Email address").fill("smoke@example.com");
    await mailAccountBoard.getByLabel("Authorization code").fill(canarySecret);
    await mailAccountBoard.getByRole("button", { name: "Advanced server settings" }).click();
    await mailAccountBoard.getByLabel("IMAP host").fill("127.0.0.1");
    await mailAccountBoard.getByLabel("IMAP port").fill(String(imapPort));
    await mailAccountBoard.getByLabel("IMAP security").selectOption("tls");

    const createResponsePromise = page.waitForResponse(
      (res) => requestPath(res.url()) === "/mail/accounts" && res.request().method() === "POST",
      { timeout: timeoutMs },
    );
    const imapTestResponsePromise = page.waitForResponse(
      (res) => requestPath(res.url()) === "/mail/accounts/imap/test" && res.request().method() === "POST",
      { timeout: timeoutMs },
    );

    await mailAccountBoard.getByRole("button", { name: "Save and test IMAP" }).click();

    const createResponse = await createResponsePromise;
    const rawCreateBody = createResponse.request().postData() ?? "";
    if (rawCreateBody.includes(canarySecret)) {
      throw new Error("Raw canary secret leaked into POST /mail/accounts HTTP request payload.");
    }
    if (createResponse.status() !== 200) {
      throw new Error(`POST /mail/accounts returned HTTP ${createResponse.status()}.`);
    }
    const createJson = await createResponse.json();
    const accountId = createJson?.account?.id;
    const credRef = createJson?.account?.credentialRefs?.[0];
    if (
      typeof accountId !== "string"
      || !credRef
      || typeof credRef.id !== "string"
      || typeof credRef.secretKey !== "string"
      || !/^ref:v1:desktop\/[0-9a-f]{32}$/.test(credRef.secretKey)
    ) {
      throw new Error("Created account did not persist an opaque desktop credential reference.");
    }

    const imapTestResponse = await imapTestResponsePromise;
    if (imapTestResponse.status() !== 200) {
      throw new Error(`Initial POST /mail/accounts/imap/test returned HTTP ${imapTestResponse.status()}.`);
    }
    const imapTestJson = await imapTestResponse.json();
    if (imapTestJson?.result?.authenticated !== true || !String(imapTestJson?.result?.capabilitySummary).includes("IMAP4rev1")) {
      throw new Error("Initial IMAP connection test did not authenticate against loopback TLS IMAP.");
    }

    fs.writeFileSync(
      metadataFile,
      JSON.stringify({ accountId, credentialRefId: credRef.id, secretKey: credRef.secretKey }, null, 2),
      "utf8",
    );
    console.log("RUN1_OPAQUE_CREDENTIAL_CREATED=True");
    console.log("RUN1_IMAP_TLS_AUTHENTICATED=True");
  } else if (phase === "run2-restart-and-legacy") {
    const accountRow = (displayName) =>
      mailAccountBoard.locator("article.nt-resource-row").filter({ hasText: displayName });

    const smokeRow = accountRow("Smoke Restart IMAP");
    const legacyOkRow = accountRow("Legacy Imported IMAP");
    const legacyMissingRow = accountRow("Legacy Missing Vault");
    await smokeRow.waitFor({ state: "visible", timeout: timeoutMs });
    await legacyOkRow.waitFor({ state: "visible", timeout: timeoutMs });
    await legacyMissingRow.waitFor({ state: "visible", timeout: timeoutMs });

    const restartTestPromise = page.waitForResponse(
      (res) => requestPath(res.url()) === "/mail/accounts/imap/test" && res.request().method() === "POST",
      { timeout: timeoutMs },
    );
    await smokeRow.getByRole("button", { name: "Test IMAP" }).click();
    const restartTestRes = await restartTestPromise;
    if (restartTestRes.status() !== 200) {
      throw new Error(`Restarted ref:v1 IMAP test returned HTTP ${restartTestRes.status()}.`);
    }
    const restartTestJson = await restartTestRes.json();
    if (restartTestJson?.result?.authenticated !== true) {
      throw new Error("Restarted ref:v1 IMAP test did not authenticate.");
    }
    console.log("RUN2_RESTART_REF_V1_AUTHENTICATED=True");

    const legacyOkPromise = page.waitForResponse(
      (res) => requestPath(res.url()) === "/mail/accounts/imap/test" && res.request().method() === "POST",
      { timeout: timeoutMs },
    );
    await legacyOkRow.getByRole("button", { name: "Test IMAP" }).click();
    const legacyOkRes = await legacyOkPromise;
    if (legacyOkRes.status() !== 200) {
      throw new Error(`Imported legacy secret://imap test returned HTTP ${legacyOkRes.status()}.`);
    }
    const legacyOkJson = await legacyOkRes.json();
    if (legacyOkJson?.result?.authenticated !== true) {
      throw new Error("Imported legacy secret://imap test did not authenticate.");
    }
    console.log("RUN2_LEGACY_IMPORTED_REF_AUTHENTICATED=True");

    const legacyMissingPromise = page.waitForResponse(
      (res) => requestPath(res.url()) === "/mail/accounts/imap/test" && res.request().method() === "POST",
      { timeout: timeoutMs },
    );
    await legacyMissingRow.getByRole("button", { name: "Test IMAP" }).click();
    const legacyMissingRes = await legacyMissingPromise;
    if (legacyMissingRes.status() !== 409) {
      throw new Error(`Missing-vault IMAP test returned HTTP ${legacyMissingRes.status()} instead of 409.`);
    }
    const legacyMissingJson = await legacyMissingRes.json();
    if (legacyMissingJson?.code !== "ACCOUNT_REAUTHENTICATION_REQUIRED") {
      throw new Error(`Unexpected missing-vault error code: ${String(legacyMissingJson?.code)}`);
    }
    await legacyMissingRow.waitFor({ state: "visible", timeout: 5000 });
    console.log("RUN2_MISSING_VAULT_FAIL_CLOSED=True");

    const deletePromise = page.waitForResponse(
      (res) => requestPath(res.url()).startsWith("/mail/accounts/") && res.request().method() === "DELETE",
      { timeout: timeoutMs },
    );
    page.once("dialog", (dialog) => dialog.accept());
    await smokeRow.getByRole("button", { name: "Delete" }).click();
    const deleteRes = await deletePromise;
    if (deleteRes.status() !== 200) {
      throw new Error(`Account delete returned HTTP ${deleteRes.status()}.`);
    }
    await smokeRow.waitFor({ state: "detached", timeout: timeoutMs });
    console.log("RUN2_ACCOUNT_CREDENTIAL_CLEANUP=True");
  } else {
    throw new Error(`Unknown phase: ${phase}`);
  }

  if (pageErrors.length > 0) {
    throw new Error(`Packaged WebView raised page errors: ${pageErrors.join(" | ")}`);
  }
} finally {
  await browser.close();
}

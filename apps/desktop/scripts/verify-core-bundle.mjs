import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const coreRoot = resolve(scriptDir, "..", "src-tauri", "resources", "core");
const manifest = JSON.parse(readFileSync(join(coreRoot, "runtime-manifest.json"), "utf8"));
const runtime = join(coreRoot, manifest.runtime);
const entry = join(coreRoot, manifest.entry);
const temporaryRoot = mkdtempSync(join(tmpdir(), "easyemail-desktop-core-"));
const stateDir = join(temporaryRoot, "state");
const configPath = join(temporaryRoot, "config.yaml");
const apiToken = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
const fakeProviderAuth = "desktop-core-smoke-custom-auth";
const fakeProviderDomain = "smoke.example.test";
const fakeMailboxAddress = `packaged-smoke@${fakeProviderDomain}`;
const fakeMailboxToken = "desktop-core-smoke-mailbox-token";
const fakeAccountSecret = "desktop-core-smoke-raw-account-secret";
const sensitiveValues = [apiToken, fakeProviderAuth, fakeMailboxToken, fakeAccountSecret];

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function startFakeProvider() {
  return new Promise((resolveServer, reject) => {
    let totalRequestCount = 0;
    let acceptedRequestCount = 0;
    let healthProbeCount = 0;
    let settingsProbeCount = 0;
    const server = createHttpServer(async (request, response) => {
      totalRequestCount += 1;
      try {
        const chunks = [];
        for await (const chunk of request) {
          chunks.push(chunk);
        }
        const bodyText = Buffer.concat(chunks).toString("utf8");
        const body = bodyText ? JSON.parse(bodyText) : {};
        if (request.headers["x-custom-auth"] !== fakeProviderAuth) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        if (request.method === "GET" && request.url === "/health_check") {
          healthProbeCount += 1;
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("ok");
          return;
        }
        if (request.method === "GET" && request.url === "/open_api/settings") {
          settingsProbeCount += 1;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ domains: [fakeProviderDomain] }));
          return;
        }
        const validRequest =
          request.method === "POST" &&
          request.url === "/api/new_address" &&
          typeof body.name === "string" &&
          body.name.trim().length > 0 &&
          body.domain === fakeProviderDomain;
        if (!validRequest) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_smoke_provider_request" }));
          return;
        }

        acceptedRequestCount += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ address: fakeMailboxAddress, jwt: fakeMailboxToken }));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_json" }));
      }
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolveServer({
        baseUrl: `http://127.0.0.1:${port}`,
        server,
        totalRequestCount: () => totalRequestCount,
        acceptedRequestCount: () => acceptedRequestCount,
        healthProbeCount: () => healthProbeCount,
        settingsProbeCount: () => settingsProbeCount,
      });
    });
  });
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForReady(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (childHasExited(child)) {
      const reason = child.exitCode !== null ? `code ${child.exitCode}` : `signal ${child.signalCode}`;
      throw new Error(`Bundled core exited during startup with ${reason}.`);
    }
    try {
      const response = await fetch(`${baseUrl}/mail/catalog`, {
        headers: { authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(2_000),
      });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // Retry until the bounded readiness deadline.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error("Bundled core readiness timed out.");
}

let child;
let childClosed;
let fakeProvider;
let credentialLeakDetected = false;
let coreOutputTail = "";
const credentialScanTailLength = Math.max(...sensitiveValues.map((value) => value.length)) - 1;
const captureCoreOutput = (chunk) => {
  const output = coreOutputTail + chunk.toString("utf8");
  credentialLeakDetected ||= sensitiveValues.some((secret) => output.includes(secret));
  coreOutputTail = output.slice(-credentialScanTailLength);
};
try {
  fakeProvider = await startFakeProvider();
  const port = await reservePort();
  const normalizedStateDir = stateDir.replaceAll("\\", "/").replaceAll('"', '\\"');
  writeFileSync(
    configPath,
    `server:\n  host: 127.0.0.1\n  port: ${port}\n  apiKey: "${apiToken}"\nstrategy:\n  strictProviderMode: true\n  providerSelections:\n    - cloudflare_temp_email\nproviders:\n  enabledProviders:\n    - cloudflare_temp_email\n  cloudflare_temp_email:\n    baseUrl: "${fakeProvider.baseUrl}"\n    apiKey: "${fakeProviderAuth}"\n    domain: "${fakeProviderDomain}"\n    instanceId: "desktop_core_smoke_provider"\n    displayName: "Desktop Core Smoke Provider"\nmaintenance:\n  enabled: false\npersistence:\n  enabled: true\n  driver: file\n  intervalMs: 1000\n  filePath: "${normalizedStateDir}/easy-email-state.json"\n`,
    "utf8",
  );
  child = spawn(runtime, [entry], {
    cwd: coreRoot,
    env: {
      ...process.env,
      EASY_EMAIL_CONFIG_PATH: configPath,
      EASY_EMAIL_STATE_DIR: stateDir,
      EASY_EMAIL_RESET_STORE_ON_BOOT: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  childClosed = new Promise((resolveClose) => child.once("close", resolveClose));
  child.stdout?.on("data", captureCoreOutput);
  child.stderr?.on("data", captureCoreOutput);

  await waitForReady(`http://127.0.0.1:${port}`, child);
  if (fakeProvider.healthProbeCount() < 1 || fakeProvider.settingsProbeCount() < 1) {
    throw new Error("Bundled core did not complete both authenticated provider startup probes.");
  }
  const unauthorized = await fetch(`http://127.0.0.1:${port}/mail/catalog`);
  await unauthorized.arrayBuffer();
  if (unauthorized.status !== 401) {
    throw new Error(`Expected unauthenticated catalog to return 401, got ${unauthorized.status}.`);
  }
  const unauthorizedContacts = await fetch(`http://127.0.0.1:${port}/mail/contacts`);
  await unauthorizedContacts.arrayBuffer();
  if (unauthorizedContacts.status !== 401) {
    throw new Error(`Expected unauthenticated contacts to return 401, got ${unauthorizedContacts.status}.`);
  }
  const unauthorizedTaxonomy = await fetch(`http://127.0.0.1:${port}/mail/taxonomy?kind=folder`);
  await unauthorizedTaxonomy.arrayBuffer();
  if (unauthorizedTaxonomy.status !== 401) {
    throw new Error(`Expected unauthenticated taxonomy to return 401, got ${unauthorizedTaxonomy.status}.`);
  }
  const unauthorizedAccounts = await fetch(`http://127.0.0.1:${port}/mail/accounts`);
  await unauthorizedAccounts.arrayBuffer();
  if (unauthorizedAccounts.status !== 401) {
    throw new Error(`Expected unauthenticated accounts to return 401, got ${unauthorizedAccounts.status}.`);
  }
  const contactCreate = await fetch(`http://127.0.0.1:${port}/mail/contacts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      displayName: "Packaged core contact",
      emailAddress: "packaged-core@example.test",
    }),
  });
  if (!contactCreate.ok) {
    throw new Error(`Authenticated packaged-core contact create failed with status ${contactCreate.status}.`);
  }
  const contactPayload = await contactCreate.json();
  if (
    contactPayload?.contact?.displayName !== "Packaged core contact"
    || contactPayload?.contact?.emailAddress !== "packaged-core@example.test"
    || contactPayload?.contact?.version !== 1
  ) {
    throw new Error("Authenticated packaged-core contact create returned an invalid canonical result.");
  }
  const contactsList = await fetch(`http://127.0.0.1:${port}/mail/contacts`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  const contactsPayload = await contactsList.json();
  if (
    !contactsList.ok
    || contactsPayload?.contacts?.length !== 1
    || contactsPayload.contacts[0]?.id !== contactPayload.contact.id
  ) {
    throw new Error("Authenticated packaged-core contact list did not read the created contact.");
  }
  const rawSecretAccount = await fetch(`http://127.0.0.1:${port}/mail/accounts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      kind: "normal_long_lived",
      displayName: "Rejected account",
      primaryAddress: "rejected-account@example.test",
      password: fakeAccountSecret,
    }),
  });
  const rawSecretPayload = await rawSecretAccount.json();
  if (
    rawSecretAccount.status !== 400
    || rawSecretPayload?.code !== "ACCOUNT_CREDENTIAL_REF_SECRET_FORBIDDEN"
    || JSON.stringify(rawSecretPayload).includes(fakeAccountSecret)
  ) {
    throw new Error("Packaged core did not reject raw account secret material safely.");
  }
  const accountCreate = await fetch(`http://127.0.0.1:${port}/mail/accounts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      kind: "normal_long_lived",
      displayName: "Packaged core account",
      primaryAddress: "packaged-core-account@example.test",
      credentialRefs: [{
        secretBackend: "fake-vault",
        secretKey: "ref:v1:packaged-core/imap",
        credentialKind: "imap_password",
        authMethod: "password",
      }],
    }),
  });
  if (!accountCreate.ok) {
    throw new Error(`Authenticated packaged-core account create failed with status ${accountCreate.status}.`);
  }
  const accountPayload = await accountCreate.json();
  if (
    accountPayload?.account?.displayName !== "Packaged core account"
    || accountPayload?.account?.credentialRefs?.[0]?.secretKey !== "ref:v1:packaged-core/imap"
    || accountPayload?.account?.credentialRefs?.[0]?.status !== "missing"
  ) {
    throw new Error("Authenticated packaged-core account create returned an invalid canonical result.");
  }
  const accountsList = await fetch(`http://127.0.0.1:${port}/mail/accounts?scope=normal`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  const accountsPayload = await accountsList.json();
  if (
    !accountsList.ok
    || !accountsPayload?.accounts?.some((account) => account.id === "acct_anonymous_virtual")
    || !accountsPayload?.accounts?.some((account) => account.id === accountPayload.account.id)
  ) {
    throw new Error("Authenticated packaged-core account list did not preserve normal visibility semantics.");
  }
  const taxonomyCreate = await fetch(`http://127.0.0.1:${port}/mail/taxonomy/folder/packaged_core`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Packaged core", color: "#8b5cf6" }),
  });
  if (!taxonomyCreate.ok) {
    throw new Error(`Authenticated packaged-core taxonomy create failed with status ${taxonomyCreate.status}.`);
  }
  const taxonomyPayload = await taxonomyCreate.json();
  if (
    taxonomyPayload?.item?.name !== "Packaged core"
    || taxonomyPayload?.item?.kind !== "folder"
    || taxonomyPayload?.item?.version !== 1
    || taxonomyPayload?.capabilities?.messageReferencePropagation !== false
  ) {
    throw new Error("Authenticated packaged-core taxonomy create returned an invalid canonical result.");
  }
  const taxonomyList = await fetch(`http://127.0.0.1:${port}/mail/taxonomy?kind=folder`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  const taxonomyListPayload = await taxonomyList.json();
  if (
    !taxonomyList.ok
    || taxonomyListPayload?.items?.length !== 1
    || taxonomyListPayload.items[0]?.id !== taxonomyPayload.item.id
  ) {
    throw new Error("Authenticated packaged-core taxonomy list did not read the created folder.");
  }
  const mailboxRequest = {
    hostId: "easyemail-desktop-core-smoke",
    provisionMode: "reuse-only",
    bindingMode: "shared-instance",
    providerTypeKey: "cloudflare_temp_email",
    requestedDomain: fakeProviderDomain,
    metadata: { source: "packaged-core-smoke" },
  };
  const totalRequestsBeforeUnauthorizedOpen = fakeProvider.totalRequestCount();
  const unauthorizedOpen = await fetch(`http://127.0.0.1:${port}/mail/mailboxes/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mailboxRequest),
  });
  await unauthorizedOpen.arrayBuffer();
  if (unauthorizedOpen.status !== 401) {
    throw new Error(`Expected unauthenticated mailbox open to return 401, got ${unauthorizedOpen.status}.`);
  }
  if (fakeProvider.totalRequestCount() !== totalRequestsBeforeUnauthorizedOpen) {
    throw new Error("Unauthenticated mailbox open reached the fake provider.");
  }

  const acceptedRequestsBeforeAuthenticatedOpen = fakeProvider.acceptedRequestCount();
  const opened = await fetch(`http://127.0.0.1:${port}/mail/mailboxes/open`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(mailboxRequest),
    signal: AbortSignal.timeout(5_000),
  });
  if (!opened.ok) {
    throw new Error(`Authenticated packaged-core mailbox open failed with status ${opened.status}.`);
  }
  const openedPayload = await opened.json();
  const openedResult = openedPayload?.result;
  if (
    openedResult?.session?.hostId !== mailboxRequest.hostId ||
    openedResult?.session?.providerTypeKey !== mailboxRequest.providerTypeKey ||
    openedResult?.session?.emailAddress !== fakeMailboxAddress ||
    openedResult?.session?.status !== "open" ||
    openedResult?.instance?.id !== "desktop_core_smoke_provider"
  ) {
    throw new Error("Authenticated packaged-core mailbox open returned an invalid canonical result.");
  }
  if (
    acceptedRequestsBeforeAuthenticatedOpen !== 0 ||
    fakeProvider.acceptedRequestCount() !== acceptedRequestsBeforeAuthenticatedOpen + 1
  ) {
    throw new Error("Authenticated mailbox open did not reach the fake provider exactly once.");
  }
} finally {
  if (child && !childHasExited(child)) {
    child.kill();
  }
  if (childClosed) {
    await childClosed;
  }
  if (fakeProvider?.server.listening) {
    await new Promise((resolveClose) => {
      fakeProvider.server.close(resolveClose);
      fakeProvider.server.closeAllConnections();
    });
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
if (credentialLeakDetected) {
  throw new Error("Bundled core output leaked a smoke credential.");
}
console.log(
  "Bundled EasyEmail core authenticated readiness, contact/taxonomy/account persistence, secret rejection, unauthenticated 401, and fake-provider mailbox open passed.",
);

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

const mode = argument("--mode");
const dataDir = argument("--data-dir");
const imapSecretKey = argument("--imap-secret-key");
const smtpSecretKey = argument("--smtp-secret-key");

if (!mode || !["seed", "verify"].includes(mode) || !dataDir || !imapSecretKey || !smtpSecretKey) {
  throw new Error(
    "Usage: node seed-desktop-upgrade-fixture.mjs --mode <seed|verify> --data-dir <dir> --imap-secret-key <ref> --smtp-secret-key <ref>",
  );
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fromConfigUrl = pathToFileURL(
  path.resolve(currentDir, "../../../service/base/dist/src/runtime/from-config.js"),
).href;
const { startEasyEmailServiceFromConfig } = await import(fromConfigUrl);

const stateDir = path.join(dataDir, "core", "state");
fs.mkdirSync(stateDir, { recursive: true });
const tempConfigPath = path.join(dataDir, "core", `.upgrade-fixture-${process.pid}.yaml`);
const apiToken = "upgrade-fixture-loopback-token-0123456789abcdef";
const normalizedState = stateDir.replace(/\\/g, "/");

fs.writeFileSync(
  tempConfigPath,
  [
    "server:",
    "  host: 127.0.0.1",
    "  port: 0",
    `  apiKey: "${apiToken}"`,
    "maintenance:",
    "  enabled: false",
    "  activeProbeEnabled: false",
    "persistence:",
    "  enabled: true",
    "  driver: file",
    "  intervalMs: 5000",
    `  filePath: "${normalizedState}/easy-email-state.json"`,
    "",
  ].join("\n"),
  "utf8",
);

function resolveRelationalDbPath() {
  const nested = path.join(stateDir, "state", "easy-email-relational.sqlite3");
  const direct = path.join(stateDir, "easy-email-relational.sqlite3");
  return fs.existsSync(nested) ? nested : direct;
}

async function callJson(baseUrl, method, routePath, body) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${routePath} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

let runtime;
try {
  process.env.EASY_EMAIL_CONFIG_PATH = tempConfigPath;
  process.env.EASY_EMAIL_STATE_DIR = stateDir;
  process.env.EASY_EMAIL_RESET_STORE_ON_BOOT = "false";
  runtime = await startEasyEmailServiceFromConfig(process.env);
  const baseUrl = runtime.server.baseUrl;

  if (mode === "seed") {
    const hostIdPath = path.join(dataDir, "desktop-host-id");
    if (!fs.existsSync(hostIdPath)) {
      fs.writeFileSync(hostIdPath, "easyemail-desktop-0123456789abcdef0123456789abcdef", "utf8");
    }

    const createdAccount = await callJson(baseUrl, "POST", "/mail/accounts", {
      kind: "normal_long_lived",
      displayName: "Upgrade Fixture Account",
      primaryAddress: "upgrade-user@example.com",
      providerLabel: "Upgrade IMAP",
      imap: {
        host: "imap.example.com",
        port: 993,
        security: "tls",
        username: "upgrade-user@example.com",
      },
      smtp: {
        host: "smtp.example.com",
        port: 465,
        security: "tls",
        username: "upgrade-user@example.com",
      },
      credentialRefs: [
        {
          secretBackend: "secret_vault",
          secretKey: imapSecretKey,
          credentialKind: "imap_password",
          authMethod: "password",
        },
        {
          secretBackend: "secret_vault",
          secretKey: smtpSecretKey,
          credentialKind: "smtp_password",
          authMethod: "password",
        },
      ],
    });
    const accountId = createdAccount.account.id;

    // Activate account send/receive capability as a previously verified pre-upgrade desktop installation
    const db = new DatabaseSync(resolveRelationalDbPath());
    try {
      db.prepare(
        "UPDATE mail_accounts SET status = 'ready', auth_status = 'valid', receive_status = 'enabled', send_status = 'enabled' WHERE id = ?",
      ).run(accountId);
      db.prepare(
        "UPDATE mail_account_credential_refs SET status = 'active' WHERE owner_account_id = ?",
      ).run(accountId);
    } finally {
      db.close();
    }

    await callJson(baseUrl, "POST", "/mail/contacts", {
      displayName: "Upgrade Contact",
      emailAddress: "upgrade-contact@example.com",
    });
    await callJson(baseUrl, "PUT", "/mail/taxonomy/label/upgradeimportant", {
      name: "UpgradeImportant",
      color: "#22c55e",
    });
    await callJson(baseUrl, "POST", "/mail/drafts", {
      accountId,
      targetAddress: "draft-target@example.com",
      subject: "Upgrade Preserved Draft",
      bodyText: "Draft body created before desktop upgrade",
    });
    await callJson(baseUrl, "POST", "/mail/send-queue", {
      accountId,
      targetAddress: "scheduled-recipient@example.com",
      subject: "Upgrade Preserved Scheduled Mail",
      bodyText: "Scheduled send body preserved across desktop upgrade",
      scheduledAt: "2035-01-01T00:00:00.000Z",
    });
    await callJson(baseUrl, "PATCH", "/mail/settings/easyemail", {
      serviceUrl: "https://upgrade-settings.example.com",
    });
    await callJson(baseUrl, "PATCH", "/mail/avatars/settings", {
      remoteEnabled: false,
      bimiEnabled: false,
      faviconEnabled: false,
      authEnabled: true,
    });

    console.log(`SEEDED_ACCOUNT_ID=${accountId}`);
  } else {
    const accountsRes = await callJson(baseUrl, "GET", "/mail/accounts?scope=normal&limit=25");
    const account = accountsRes.accounts.find(
      (item) => item.primaryAddress === "upgrade-user@example.com",
    );
    if (!account) {
      throw new Error("Upgrade verification failed: seeded normal account is missing.");
    }
    const secretKeys = new Set((account.credentialRefs ?? []).map((ref) => ref.secretKey));
    if (!secretKeys.has(imapSecretKey) || !secretKeys.has(smtpSecretKey)) {
      throw new Error("Upgrade verification failed: opaque credentialRefs were not preserved.");
    }

    const contactsRes = await callJson(baseUrl, "GET", "/mail/contacts?limit=25");
    if (!contactsRes.contacts.some((c) => c.emailAddress === "upgrade-contact@example.com")) {
      throw new Error("Upgrade verification failed: contact was not preserved.");
    }

    const taxonomyRes = await callJson(baseUrl, "GET", "/mail/taxonomy?kind=label&limit=25");
    if (!taxonomyRes.items.some((item) => item.name === "UpgradeImportant")) {
      throw new Error("Upgrade verification failed: taxonomy label was not preserved.");
    }

    const draftsRes = await callJson(
      baseUrl,
      "GET",
      `/mail/messages?scope=normal_account&accountId=${encodeURIComponent(account.id)}&folder=drafts`,
    );
    if (!draftsRes.messages.some((msg) => msg.subject === "Upgrade Preserved Draft")) {
      throw new Error("Upgrade verification failed: local draft message was not preserved.");
    }

    const queueRes = await callJson(
      baseUrl,
      "GET",
      `/mail/send-queue?accountId=${encodeURIComponent(account.id)}&limit=25`,
    );
    const queued = queueRes.items.find(
      (item) => item.subject === "Upgrade Preserved Scheduled Mail",
    );
    if (!queued || queued.status !== "queued") {
      throw new Error("Upgrade verification failed: scheduled send queue item was not preserved.");
    }

    const eeSettings = await callJson(baseUrl, "GET", "/mail/settings/easyemail");
    if (eeSettings.settings?.serviceUrl !== "https://upgrade-settings.example.com") {
      throw new Error("Upgrade verification failed: EasyEmail client settings were not preserved.");
    }

    const avatarSettings = await callJson(baseUrl, "GET", "/mail/avatars/settings");
    if (avatarSettings.settings?.remoteEnabled !== false) {
      throw new Error("Upgrade verification failed: avatar settings were not preserved.");
    }

    console.log("UPGRADE_READBACK_OK=True");
  }
} finally {
  if (runtime) {
    await runtime.close();
  }
  if (fs.existsSync(tempConfigPath)) {
    fs.unlinkSync(tempConfigPath);
  }
}

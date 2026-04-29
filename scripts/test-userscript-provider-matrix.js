const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }
    out[key] = next;
    index += 1;
  }
  return out;
}

function requirePlaywright(repoRoot) {
  const candidates = [
    path.join(repoRoot, ".tmp", "playwright-harness", "node_modules", "playwright"),
    path.join(repoRoot, ".tmp", "playwright-runner", "node_modules", "playwright"),
    path.join(repoRoot, ".tmp", "playwright-probe", "node_modules", "playwright"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }
  throw new Error("Playwright runtime not found under .tmp/playwright-*.");
}

const DEFAULT_PROVIDERS = [
  "cloudflare_temp_email",
  "mailtm",
  "duckmail",
  "guerrillamail",
  "tempmail-lol",
  "etempmail",
  "moemail",
  "m2u",
  "gptmail",
  "mail2925",
  "im215",
];

const TEMPLATES = [
  {
    key: "numeric_plain",
    expectedCode: "135790",
    subject: "Numeric verification sample",
    textBody: "Your verification code is 135790. Keep it for 10 minutes.",
    htmlBody: null,
  },
  {
    key: "numeric_colored_html",
    expectedCode: "246810",
    subject: "Numeric html verification sample",
    textBody: "Alert: order 998877 is separate. Your login code is 246810.",
    htmlBody: '<html><body><div style="font-family:Arial;background:#fff7ed;border:1px solid #fdba74;padding:16px"><p style="color:#9a3412">Security review notice</p><p>Ignore order <strong>998877</strong>.</p><p>Your login code is <span style="color:#2563eb;font-size:24px;font-weight:700">246810</span>.</p></div></body></html>',
  },
  {
    key: "alpha_html",
    expectedCode: "QWERTY",
    subject: "Alphabetic verification sample",
    textBody: "Use code QWERTY to continue.",
    htmlBody: '<html><body><div style="font-family:Arial"><h2 style="color:#d14a4a">Verification</h2><p>Your code is <strong style="color:#1b6ef3">QWERTY</strong>.</p></div></body></html>',
  },
  {
    key: "mixed_html",
    expectedCode: "A1B2C3",
    subject: "Mixed verification sample",
    textBody: "Use code A1B2C3 to continue.",
    htmlBody: '<html><body><div style="background:#0f172a;color:#e2e8f0;padding:16px"><p>Order #20260428</p><p>Primary code: <span style="color:#22c55e;font-size:20px;font-weight:700">A1B2C3</span></p><p>Ignore backup id 998877.</p></div></body></html>',
  },
  {
    key: "mixed_text_noise",
    expectedCode: "ZX-41Q8-PLM7",
    subject: "Long mixed verification sample",
    textBody: "Account 220044 requires confirmation. Use verification code ZX-41Q8-PLM7 to continue. Ignore ticket 771199.",
    htmlBody: '<html><body><table style="font-family:Arial;border-collapse:collapse"><tr><td style="padding:8px;color:#475569">Account 220044 requires confirmation.</td></tr><tr><td style="padding:8px;background:#eff6ff;border:1px solid #93c5fd">Verification code: <strong style="font-size:18px;color:#1d4ed8">ZX-41Q8-PLM7</strong></td></tr><tr><td style="padding:8px;color:#64748b">Ignore ticket 771199.</td></tr></table></body></html>',
  },
];

function randomHex(length) {
  return [...crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

function parseObservedAtMs(value) {
  const parsed = Date.parse(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

async function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv.slice(2));
  const importCodeFile = path.resolve(repoRoot, args["import-code-file"] || path.join(".tmp", "real-import-code.txt"));
  const baseUrl = String(args["base-url"] || "http://127.0.0.1:18091").replace(/\/+$/, "");
  const apiKey = String(args["api-key"] || "").trim();
  const senderDomain = String(args["sender-domain"] || "tx-mail.aiaimimi.com").trim().toLowerCase();
  const providerRetryCount = Math.max(0, Number.parseInt(args["provider-retry-count"] || "1", 10) || 1);
  const providerRetryDelayMs = (Math.max(0, Number.parseInt(args["provider-retry-delay-seconds"] || "10", 10) || 10)) * 1000;
  const sendRetryCount = Math.max(0, Number.parseInt(args["send-retry-count"] || "2", 10) || 2);
  const userscriptOverrides = {
    gptmail_apiKey: String(args["gptmail-api-key"] || "").trim(),
    mail2925_account: String(args["mail2925-account"] || "").trim(),
    mail2925_jwtToken: String(args["mail2925-jwt-token"] || "").trim(),
    mail2925_deviceUid: String(args["mail2925-device-uid"] || "").trim(),
    mail2925_cookieHeader: String(args["mail2925-cookie-header"] || "").trim(),
  };
  const providers = String(args.providers || "")
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const providerList = providers.length > 0 ? providers : DEFAULT_PROVIDERS;

  if (!apiKey) {
    throw new Error("--api-key is required.");
  }
  if (!fs.existsSync(importCodeFile)) {
    throw new Error(`Import code file not found: ${importCodeFile}`);
  }

  const importCode = fs.readFileSync(importCodeFile, "utf8").trim();
  if (!importCode) {
    throw new Error(`Import code file is empty: ${importCodeFile}`);
  }

  const scriptText = fs.readFileSync(path.join(repoRoot, "runtimes", "userscript", "easy_email_proxy.user.js"), "utf8");
  const { chromium } = requirePlaywright(repoRoot);

  const apiHeaders = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  async function easyEmailRequest(method, requestPath, body) {
    const response = await fetch(`${baseUrl}${requestPath}`, {
      method,
      headers: apiHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      const reason = data && (data.message || data.error || data.raw) ? ` :: ${data.message || data.error || data.raw}` : "";
      throw new Error(`EasyEmail ${method} ${requestPath} failed: HTTP ${response.status}${reason}`);
    }
    return data;
  }

  let senderSessionId = "";
  async function ensureSenderSession() {
    if (senderSessionId) {
      return senderSessionId;
    }
    const response = await easyEmailRequest("POST", "/mail/mailboxes/open", {
      hostId: "userscript-matrix-sender",
      providerTypeKey: "cloudflare_temp_email",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      ttlMinutes: 30,
      requestedDomain: senderDomain,
    });
    senderSessionId = String(response.result && response.result.session && response.result.session.id || "").trim();
    if (!senderSessionId) {
      throw new Error("Failed to create sender mailbox session.");
    }
    return senderSessionId;
  }

  async function sendTemplate(recipientEmail, template) {
    let lastError = null;
    for (let attempt = 0; attempt <= sendRetryCount; attempt += 1) {
      try {
        const sessionId = await ensureSenderSession();
        const response = await easyEmailRequest("POST", "/mail/mailboxes/send", {
          sessionId,
          toEmailAddress: recipientEmail,
          subject: template.subject,
          textBody: template.textBody,
          htmlBody: template.htmlBody,
          fromName: "EasyEmail Matrix",
        });
        return response.result || response;
      } catch (error) {
        lastError = error;
        senderSessionId = "";
        if (attempt >= sendRetryCount) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function bridgeRequest(options) {
      const response = await fetch(options.url, {
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.data === undefined ? undefined : options.data,
      });
      const responseText = await response.text();
      const responseHeaders = Array.from(response.headers.entries())
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
      return {
        status: response.status,
        responseText,
        responseHeaders,
      };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const injectedPages = new WeakMap();

  await context.exposeFunction("__easyEmailBridgeRequest", bridgeRequest);
  await context.addInitScript(() => {
      window.__easyEmailStore = {};
      window.__easyEmailMenus = [];
      window.GM_getValue = (key, fallback) => Object.prototype.hasOwnProperty.call(window.__easyEmailStore, key)
        ? window.__easyEmailStore[key]
        : fallback;
      window.GM_setValue = (key, value) => { window.__easyEmailStore[key] = value; };
      window.GM_addStyle = () => {};
      window.GM_setClipboard = () => {};
      window.GM_registerMenuCommand = (name, fn) => { window.__easyEmailMenus.push({ name, fn }); return window.__easyEmailMenus.length; };
      window.GM_xmlhttpRequest = (options) => {
        window.__easyEmailBridgeRequest({
          method: options.method,
          url: options.url,
          headers: options.headers,
          data: options.data,
        }).then((response) => {
          if (typeof options.onload === "function") {
            options.onload(response);
          }
        }).catch((error) => {
          if (typeof options.onerror === "function") {
            options.onerror({ error: String(error) });
          }
    });
      };
      window.prompt = () => null;
    });

  async function attachUserscriptRuntime(page) {
    const existingTask = injectedPages.get(page);
    if (existingTask) {
      await existingTask;
      return;
    }
    const task = (async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await page.waitForLoadState("domcontentloaded");
          await page.evaluate((script) => {
            if (window.__easyEmailHarnessInjected) {
              return;
            }
            window.__easyEmailHarnessInjected = true;
            (0, eval)(script);
          }, scriptText);
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/Execution context was destroyed|Target closed|navigation/i.test(message) || attempt === 5) {
            throw error;
          }
          await page.waitForTimeout(500);
        }
      }
    })();
    injectedPages.set(page, task);
    await task;
  }

  context.on("page", (page) => {
    attachUserscriptRuntime(page).catch(() => {});
  });

  async function createUserscriptPage() {
    const page = await context.newPage();
    await page.goto(`https://example.com/?easyemail_import_code=${encodeURIComponent(importCode)}`, { waitUntil: "domcontentloaded" });
    await attachUserscriptRuntime(page);
    await page.evaluate(() => {
      if (!document.getElementById("emailField")) {
        const email = document.createElement("input");
        email.id = "emailField";
        document.body.appendChild(email);
      }
      if (!document.getElementById("otpField")) {
        const otp = document.createElement("input");
        otp.id = "otpField";
        document.body.appendChild(otp);
      }
    });
    await page.waitForFunction(() => Boolean(
      window.__easyEmailDebug
      && document.getElementById("eep-mini-bar")
      && document.getElementById("eep-panel"),
    ), undefined, { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.evaluate((overrides) => {
      Object.entries(overrides || {}).forEach(([key, value]) => {
        if (!value) return;
        window.__easyEmailStore[`easyemail.runtime.${key}`] = value;
      });
    }, userscriptOverrides);
    return page;
  }

  async function configureProvider(page, providerKey) {
    await page.evaluate((provider) => {
      const setValue = (selector, value) => {
        const node = document.querySelector(selector);
        if (!node) {
          throw new Error(`Missing settings control: ${selector}`);
        }
        node.value = value;
        node.dispatchEvent(new Event("change", { bubbles: true }));
      };
      setValue('[data-setting="providerMode"]', "explicit");
      setValue('[data-setting="explicitProviderKey"]', provider);
      if (provider === "cloudflare_temp_email") {
        window.__easyEmailStore["easyemail.runtime.cloudflare_preferredDomain"] = "";
        window.__easyEmailStore["easyemail.runtime.configProviderKey"] = "cloudflare_temp_email";
        const node = document.querySelector('[data-setting="cloudflare_preferredDomain"]');
        if (node) {
          node.value = "";
          node.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    }, providerKey);
    await page.waitForTimeout(300);
  }

  async function openMailbox(page) {
    await page.locator('#eep-mini-bar button[data-action="open-mailbox"]').click();
    try {
      await page.waitForFunction(() => {
        const email = document.getElementById("eep-current-email");
        return email && /@/.test(String(email.textContent || "").trim());
      }, undefined, { timeout: 180000 });
    } catch (error) {
      const detail = await page.evaluate(() => {
        const snapshot = window.__easyEmailDebug && typeof window.__easyEmailDebug.snapshot === "function"
          ? window.__easyEmailDebug.snapshot()
          : null;
        const logs = String(document.getElementById("eep-log")?.textContent || "").trim();
        return { snapshot, logs };
      }).catch(() => ({ snapshot: null, logs: "" }));
      throw new Error(`Timed out waiting for mailbox open. Detail: ${JSON.stringify(detail)}. Root error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return page.evaluate(() => ({
      email: String(document.getElementById("eep-current-email")?.textContent || "").trim(),
      provider: String(document.getElementById("eep-current-provider")?.textContent || "").trim(),
      mailboxId: String(
        window.__easyEmailStore["easyemail.runtime.currentMailboxId"]
        || window.__easyEmailStore.currentMailboxId
        || "",
      ).trim(),
    }));
  }

  async function waitForCode(page, expectedCode, sentAfterMs) {
    await page.locator('#eep-side-poll-btn').click();
    try {
      await page.waitForFunction(({ expected, minObservedAtMs }) => {
        const debug = window.__easyEmailDebug;
        const snapshot = debug && typeof debug.snapshot === "function" ? debug.snapshot() : null;
        const messages = Array.isArray(snapshot && snapshot.currentMessages) ? snapshot.currentMessages : [];
        return messages.some((message) => {
          const code = String(message && message.extractedCode || "").trim();
          const observedAtMs = Date.parse(String(message && message.observedAt || "").trim()) || 0;
          return code === expected && observedAtMs >= minObservedAtMs;
        });
      }, { expected: expectedCode, minObservedAtMs: sentAfterMs }, { timeout: 240000 });
    } catch (error) {
      const snapshot = await page.evaluate(() => {
        if (window.__easyEmailDebug && typeof window.__easyEmailDebug.snapshot === "function") {
          return window.__easyEmailDebug.snapshot();
        }
        return null;
      }).catch(() => null);
      const detail = snapshot ? JSON.stringify(snapshot) : "no-debug-snapshot";
      throw new Error(`Timed out waiting for code ${expectedCode}. Snapshot: ${detail}. Root error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return page.evaluate(({ expected, minObservedAtMs }) => {
      const snapshot = window.__easyEmailDebug && typeof window.__easyEmailDebug.snapshot === "function"
        ? window.__easyEmailDebug.snapshot()
        : null;
      const messages = Array.isArray(snapshot && snapshot.currentMessages) ? snapshot.currentMessages : [];
      const matched = messages.find((message) => {
        const code = String(message && message.extractedCode || "").trim();
        const observedAtMs = Date.parse(String(message && message.observedAt || "").trim()) || 0;
        return code === expected && observedAtMs >= minObservedAtMs;
      });
      return String(matched && matched.extractedCode || "").trim();
    }, { expected: expectedCode, minObservedAtMs: sentAfterMs });
  }

  const results = [];

  try {
    for (const provider of providerList) {
      let providerResult = null;
      for (let attempt = 0; attempt <= providerRetryCount; attempt += 1) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, providerRetryDelayMs));
        }
        const page = await createUserscriptPage();
        try {
          console.error(`[userscript-matrix] provider=${provider} attempt=${attempt + 1} configure`);
          await configureProvider(page, provider);
          console.error(`[userscript-matrix] provider=${provider} attempt=${attempt + 1} open-mailbox`);
          const mailbox = await openMailbox(page);
          console.error(`[userscript-matrix] provider=${provider} email=${mailbox.email}`);
          const templateResults = [];
          const runNonce = `${Date.now()}-${randomHex(4)}`;
          for (const template of TEMPLATES) {
            const runtimeTemplate = {
              ...template,
              subject: `${template.subject} [${runNonce}-${template.key}]`,
            };
            console.error(`[userscript-matrix] provider=${provider} template=${template.key} send`);
            const sentAfterMs = Date.now() - 120000;
            await sendTemplate(mailbox.email, runtimeTemplate);
            console.error(`[userscript-matrix] provider=${provider} template=${template.key} wait-code expected=${template.expectedCode}`);
            const actualCode = await waitForCode(page, template.expectedCode, sentAfterMs);
            console.error(`[userscript-matrix] provider=${provider} template=${template.key} actual=${actualCode}`);
            templateResults.push({
              template: template.key,
              expectedCode: template.expectedCode,
              actualCode,
            });
          }
          providerResult = {
            provider,
            ok: true,
            email: mailbox.email,
            mailboxId: mailbox.mailboxId,
            templates: templateResults,
          };
          await page.close();
          break;
        } catch (error) {
          console.error(`[userscript-matrix] provider=${provider} attempt=${attempt + 1} failed=${error instanceof Error ? error.message : String(error)}`);
          providerResult = {
            provider,
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          };
          await page.close();
        }
      }
      results.push(providerResult);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  console.log(JSON.stringify(results, null, 2));
  if (results.some((item) => !item.ok)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

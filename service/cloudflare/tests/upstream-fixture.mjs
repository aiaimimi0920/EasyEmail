import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { buildLocalWorker } from "../../../upstreams/cloudflare_temp_email/worker/scripts/build-local.mjs";

export const SITE_PASSWORD = "synthetic-upstream-site-password";
export const ADMIN_PASSWORD = "synthetic-upstream-admin-password";
const upstream = new URL("../../../upstreams/cloudflare_temp_email/", import.meta.url);

export async function upstreamFixture(bindings = {}, captureSend = false) {
  const root = process.env.EASYEMAIL_TEST_ROOT;
  assert.ok(root && path.isAbsolute(root), "Set an absolute isolated EASYEMAIL_TEST_ROOT");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "upstream-"));
  const sqlitePath = path.join(directory, "state/d1/miniflare-D1DatabaseObject", "a".repeat(64) + ".sqlite-journal");
  if (process.platform === "win32" && sqlitePath.length >= 260) throw Error("Use a shorter EASYEMAIL_TEST_ROOT for workerd SQLite paths on Windows");
  let { scriptPath, modulesRoot } = await buildLocalWorker(directory);
  const externalRequests = [], sent = [];
  if (captureSend) {
    scriptPath = path.join(modulesRoot, "send-capture.mjs");
    await writeFile(scriptPath, `import worker from './worker.js';
export default { ...worker, fetch(request, env, ctx) {
  return worker.fetch(request, { ...env, SEND_MAIL: { async send(message) {
    const response = await fetch('https://synthetic-send-binding.test/capture', {
      method: 'POST', body: JSON.stringify(message) });
    if (!response.ok) throw Error('Synthetic binding rejected');
    return response.json();
  } } }, ctx);
} };`, { encoding: "utf8", flag: "wx" });
    const bundled = path.join(modulesRoot, "send-worker.mjs");
    await build({ entryPoints: [scriptPath], outfile: bundled, bundle: true, format: "esm", platform: "neutral",
      target: "es2022", external: ["cloudflare:*", "node:*", ...builtinModules] });
    scriptPath = bundled;
  }
  const mf = new Miniflare(convertV4MiniflareOptions({ name: "complete-upstream-test", modules: true,
    host: "127.0.0.1", scriptPath, modulesRoot, compatibilityDate: "2025-04-01",
    compatibilityFlags: ["nodejs_compat"], unsafeTriggerHandlers: true, d1Databases: { DB: "complete-upstream-test" },
    resourcePersistencePath: path.join(directory, "state"),
    async outboundService(request) {
      if (captureSend && request.url === "https://synthetic-send-binding.test/capture") {
        sent.push(await request.json()); return Response.json({ messageId: `synthetic-${sent.length}` });
      }
      externalRequests.push(request.url); return new Response("Unexpected external request", { status: 502 });
    },
    bindings: { JWT_SECRET: "synthetic-upstream-jwt-secret-32bytes-minimum", DOMAINS: '["cf.example.test"]',
      PASSWORDS: JSON.stringify([SITE_PASSWORD]), ADMIN_PASSWORDS: JSON.stringify([ADMIN_PASSWORD]),
      ENABLE_USER_CREATE_EMAIL: "true", ENABLE_USER_DELETE_EMAIL: "true", E2E_TEST_MODE: "true", ...bindings } }));
  let timer;
  try {
    await Promise.race([mf.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Complete upstream startup exceeded 45s")), 45000); })]);
    const db = await mf.getD1Database("DB");
    // Blank lines separate statements in this source; trigger bodies contain semicolons.
    const schema = await readFile(new URL("db/schema.sql", upstream), "utf8");
    for (const sql of schema.trim().split(/\r?\n\s*\r?\n/)) {
      try { await db.prepare(sql).run(); }
      catch (error) { throw Error(`Isolated schema initialization failed: ${sql}\n${error.stack}\nExternal fetches: ${JSON.stringify(externalRequests)}`, { cause: error }); }
    }
    const baseUrl = (await mf.ready).origin;
    return { directory, db, externalRequests, baseUrl, sent,
      bindings: {
        PROVIDER_CONFIG: JSON.stringify([{ id: "self", type: "cloudflare", baseUrl, domains: ["cf.example.test"] }]),
        PROVIDER_SECRETS: JSON.stringify({ self: { apiKey: ADMIN_PASSWORD, sitePassword: SITE_PASSWORD } }),
        MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "a3".repeat(32) } }),
      },
      async request(route, { method = "GET", admin = false, site = true, token, body, headers = {} } = {}) {
        const h = new Headers(headers);
        if (site) h.set("x-custom-auth", SITE_PASSWORD);
        if (admin) h.set("x-admin-auth", ADMIN_PASSWORD);
        if (token) h.set("authorization", `Bearer ${token}`);
        if (body !== undefined) h.set("content-type", "application/json");
        const response = await mf.dispatchFetch(`http://upstream.test${route}`, { method, headers: h,
          body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text();
        return { status: response.status, headers: response.headers, text,
          body: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : null };
      },
      async create(name = `mailbox${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`) {
        const result = await this.request("/admin/new_address", { method: "POST", admin: true,
          body: { name, domain: "cf.example.test", enablePrefix: false } });
        assert.equal(result.status, 200, result.text);
        const row = await db.prepare("SELECT id,name FROM address WHERE name=?").bind(result.body.address).first();
        assert.ok(row, result.text);
        return { ...result.body, id: row.id };
      },
      receive(to, raw = mime(to), from = "noreply@example.test") {
        return this.request("/admin/test/receive_mail", { method: "POST", admin: true, body: { from, to, raw } });
      },
      async deliver(to, raw = mime(to), from = "noreply@example.test") {
        const params = new URLSearchParams({ format: "json", from, to });
        const response = await mf.dispatchFetch(`${baseUrl}/cdn-cgi/local/email?${params}`, {
          method: "POST", headers: { "content-type": "message/rfc822" }, body: raw });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        const body = JSON.parse(text);
        assert.equal(body.outcome, "ok", JSON.stringify(body));
        return body;
      },
      async scheduled() { return (await mf.getWorker()).scheduled({ cron: "0 0 * * *", scheduledTime: Date.now() }); },
      async close() { await mf.dispose(); assert.deepEqual(externalRequests, [], "No unexpected external fetch is allowed"); },
    };
  } catch (error) { await mf.dispose(); throw error; }
  finally { clearTimeout(timer); }
}

export function mime(to, code = "485723") {
  return [`From: Sender <noreply@example.test>`, `To: ${to}`, "Subject: Verify complete worker",
    `Message-ID: <${crypto.randomUUID()}@example.test>`, "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"', "", `Your verification code is ${code}.`, ""].join("\r\n");
}

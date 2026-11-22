import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { cfMail } from "./provider-fixture.mjs";
import { legacyCleanupPlugin } from "./legacy-cleanup-bundle.mjs";
import { addressCreatePlugin } from "./address-create-bundle.mjs";

export async function remoteFixture({ fullSchema = false, legacyAuth = false, customBindings = {} } = {}) {
  const root = process.env.EASYEMAIL_TEST_ROOT; assert.ok(root && path.isAbsolute(root)); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "remote-")), scriptPath = path.join(directory, "worker.mjs");
  await build({ entryPoints: [fileURLToPath(new URL(legacyAuth ? "./address-auth-worker.ts" : "./remote-worker.ts", import.meta.url))], outfile: scriptPath,
    bundle: true, format: "esm", target: "es2022", platform: "browser", plugins: legacyAuth ? [legacyCleanupPlugin(), addressCreatePlugin()] : [] });
  const progress = (stage) => appendFile(path.join(directory, "init.log"), `${new Date().toISOString()} ${stage}\n`, "utf8");
  await progress("bundle ready");
  const mf = new Miniflare(convertV4MiniflareOptions({ name: "remote-contract", host: "127.0.0.1", modules: true,
    scriptPath, modulesRoot: directory, compatibilityDate: "2026-10-23", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "remote-contract" }, resourcePersistencePath: path.join(directory, "state"),
    bindings: { JWT_SECRET: "synthetic-address-auth-secret-32bytes-minimum", ENABLE_USER_DELETE_EMAIL: "true", DOMAINS: '["cf.example.test"]',
      ADMIN_PASSWORDS: '["synthetic-cf-admin"]', ENABLE_USER_CREATE_EMAIL: 'true', ...customBindings } }));
  let timer;
  try {
    await Promise.race([mf.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("remote fixture startup exceeded 30s")), 30000); })]);
    await progress("runtime ready");
  } catch (error) {
    await progress(`startup failed: ${error.message}`);
    void mf.dispose().catch(() => {});
    throw error;
  } finally { clearTimeout(timer); }
  const db = await mf.getD1Database("DB");
  const baseSchema = fullSchema ? (await readFile(new URL("../../../upstreams/cloudflare_temp_email/db/schema.sql", import.meta.url), "utf8"))
    .trim().split(/\r?\n\s*\r?\n/).filter(Boolean) : ["CREATE TABLE address(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE)",
      "CREATE TABLE raw_mails(id INTEGER PRIMARY KEY,message_id TEXT,source TEXT,address TEXT,raw TEXT,raw_blob BLOB,metadata TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)"];
  for (const sql of [...baseSchema,
    "CREATE TABLE fixture_credentials(token TEXT PRIMARY KEY,address TEXT,address_id INTEGER)",
    "CREATE TABLE fixture_settings(enabled INTEGER)", "INSERT INTO fixture_settings VALUES(1)"]) await db.prepare(sql).run();
  const schema = await readFile(new URL("../../../upstreams/cloudflare_temp_email/db/2026-10-28-mail-resources.sql", import.meta.url), "utf8");
  // The migration uses blank lines as statement boundaries, preserving trigger bodies.
  const statements = schema.trim().split(/\r?\n\s*\r?\n/).filter(Boolean);
  const addressSchema = await readFile(new URL("../../../upstreams/cloudflare_temp_email/db/2026-10-28-address-deletions.sql", import.meta.url), "utf8");
  async function migrate() { await db.batch([...statements, addressSchema].map((sql) => db.prepare(sql))); }
  await migrate(); await progress("schema ready");
  if (legacyAuth) for (const sql of ["CREATE TABLE fixture_auth_control(mode TEXT)", "INSERT INTO fixture_auth_control VALUES('normal')",
    "CREATE TABLE fixture_dispatch_counter(n INTEGER)", "INSERT INTO fixture_dispatch_counter VALUES(0)",
    "CREATE TABLE fixture_external_counter(n INTEGER)", "INSERT INTO fixture_external_counter VALUES(0)"]) await db.prepare(sql).run();
  const calls = [], modes = new Map(), gates = new Map(), responseGates = new Map();
  function hold(map, route) {
    let enter, release; const entered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Fixture gate not reached: ${route}`)), 10000); timer.unref();
      enter = () => { clearTimeout(timer); resolve(); };
    });
    const wait = new Promise((resolve) => { release = resolve; }); map.set(route, { enter, wait });
    return { entered, release };
  }
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const url = new URL(request.url, "http://fixture");
    try {
      let parsed; try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = "invalid synthetic input"; }
      calls.push({ path: url.pathname, method: request.method, headers: request.headers, body: parsed });
      const gate = gates.get(url.pathname); if (gate) { gates.delete(url.pathname); gate.enter(); await gate.wait; }
      const mode = modes.get(url.pathname);
      if (typeof mode === "number") { response.writeHead(mode, { "content-type": "application/json" }); response.end('{"error":"synthetic"}'); return; }
      if (mode && typeof mode === "object") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(mode)); return; }
      const headers = new Headers(); for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
      const upstream = new URL(url); if (legacyAuth) upstream.pathname = upstream.pathname.replace(/^\/cf/, "");
      const result = await mf.dispatchFetch(upstream.href, { method: request.method, headers, body: body || undefined });
      const after = responseGates.get(url.pathname); if (after) { responseGates.delete(url.pathname); after.enter(); await after.wait; }
      if (mode === "lose-response") { await result.body?.cancel(); response.destroy(); return; }
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/cf`;
  return { directory, db, calls, modes, migrate, baseUrl,
    bindings: { PROVIDER_CONFIG: JSON.stringify([{ id: "self", type: "cloudflare", baseUrl, domains: ["cf.example.test"] }]),
      PROVIDER_SECRETS: JSON.stringify({ self: { apiKey: "synthetic-cf-admin", sitePassword: "synthetic-site-password" } }),
      MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "a3".repeat(32) } }) },
    async seed(address, id, overrides = {}) {
      const mail = { ...cfMail(address, id, "Your verification code is 485723.", new Date().toISOString()), ...overrides };
      await db.prepare("INSERT INTO raw_mails(id,address,raw,message_id) VALUES(?,?,?,?)").bind(id, address, JSON.stringify(mail), `<${id}@synthetic.test>`).run();
      return mail;
    },
    async request(route, token, body, extraHeaders = {}) {
      const response = await fetch(`${baseUrl}/api${route}`, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(25000),
        headers: { authorization: `Bearer ${token}`, "x-custom-auth": "synthetic-site-password", "content-type": "application/json", ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
    hold: (route) => hold(gates, route),
    holdResponse: (route) => hold(responseGates, route),
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await mf.dispose(); },
  };
}

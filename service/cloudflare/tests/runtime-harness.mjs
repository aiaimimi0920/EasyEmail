import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { buildApplication } from "../scripts/build.mjs";
import { build } from "esbuild";
import { migrationStatements } from "./migration-sql.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const ORIGIN = "http://localhost:8787";
export const INVITE = "synthetic-local-invitation-32bytes-minimum";
export const PASSWORD = "Synthetic-test-password-735296";

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function createHarness(overrides = {}, browser = false, through = null, testEntry = null, resources = {}, buildOptions = {}) {
  const root = process.env.EASYEMAIL_TEST_ROOT;
  assert.ok(root && path.isAbsolute(root), "Set EASYEMAIL_TEST_ROOT to an absolute isolated test output directory");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "identity-"));
  const bundlePath = path.join(directory, "worker.mjs");
  await buildApplication(directory);
  if (testEntry) {
    await build({ entryPoints: [fileURLToPath(testEntry)], outfile: bundlePath, bundle: true,
      format: "esm", platform: "neutral", target: "es2022", external: ["node:crypto", "cloudflare:sockets"], sourcemap: true, ...buildOptions });
  }
  const port = browser ? await unusedPort() : undefined;
  const origin = browser ? `http://127.0.0.1:${port}` : ORIGIN;
  const settings = { name: "easyemail-test", modules: true, port, host: "127.0.0.1", scriptPath: bundlePath, modulesRoot: directory, compatibilityDate: "2026-10-23",
    compatibilityFlags: ["nodejs_compat"], d1Databases: { DB: "identity-test" },
    resourcePersistencePath: path.join(directory, "state"), assets: { directory: path.join(directory, "web"), binding: "ASSETS",
      routerConfig: { invoke_user_worker_ahead_of_assets: true, has_user_worker: true } },
    bindings: { APP_ORIGIN: origin, REGISTRATION_TOKEN: INVITE, ...overrides }, ...resources };
  let mf;
  let db;
  let baseUrl;
  async function start() {
    mf = new Miniflare(convertV4MiniflareOptions(settings));
    baseUrl = await mf.ready;
    db = await mf.getD1Database("DB");
  }
  try { await start(); }
  catch (error) { await mf?.dispose(); throw error; }
  const applied = new Set();
  async function migrate(upTo = null) {
    for (const file of (await readdir(path.join(packageRoot, "migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
      if (applied.has(file) || (upTo && file > upTo)) continue;
      const schema = await readFile(path.join(packageRoot, "migrations", file), "utf8");
      for (const statement of migrationStatements(schema)) await db.prepare(statement).run();
      applied.add(file);
    }
  }
  await migrate(through);

  return {
    directory,
    appOrigin: origin,
    get baseUrl() { return baseUrl; },
    get db() { return db; },
    bucket: (binding = "OUTBOX") => mf.getR2Bucket(binding),
    migrate,
    async request(route, { method = "GET", cookie, token, origin: requestOrigin = origin, body, headers = {} } = {}) {
      const h = new Headers(headers);
      h.set("connection", "close");
      if (requestOrigin !== null) h.set("origin", requestOrigin);
      if (cookie) h.set("cookie", cookie);
      if (token !== undefined) h.set("authorization", `Bearer ${token}`);
      if (body !== undefined && !h.has("content-type")) h.set("content-type", "application/json");
      const response = await fetch(new URL(route, baseUrl), { method, headers: h,
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      assert.ok(response.headers.get("content-type")?.includes("application/json"), `Unexpected HTTP ${response.status}: ${text}`);
      return { status: response.status, headers: response.headers, text, body: JSON.parse(text),
        cookie: response.headers.get("set-cookie")?.split(";")[0] };
    },
    async register(username) {
      const response = await this.request("/api/v1/auth/register", { method: "POST", body: { username, password: PASSWORD, invite: INVITE } });
      assert.equal(response.status, 201, response.text);
      return { ...response.body.user, cookie: response.cookie };
    },
    async resetLimits() { await db.prepare("DELETE FROM auth_rate_limits").run(); },
    async restart(bindings = {}) { await mf.dispose(); Object.assign(settings.bindings, bindings); await start(); },
    async scheduled(scheduledTime = Date.now(), cron = "*/15 * * * *") { return (await mf.getWorker()).scheduled({ cron, scheduledTime }); },
    async close() { await mf.dispose(); },
    async comparePassword(username) {
      const row = await db.prepare("SELECT password_hash FROM users WHERE username = ?").bind(username).first();
      const [algorithm, n, r, p, salt, expected] = row.password_hash.split("$");
      assert.equal(algorithm, "scrypt");
      const actual = scryptSync(PASSWORD, salt, 32, { N: Number(n), r: Number(r), p: Number(p), maxmem: 33554432 });
      assert.equal(actual.toString("hex"), expected);
      assert.deepEqual([n, r, p], ["16384", "8", "5"]);
      return row.password_hash;
    },
  };
}

export async function seedMailbox(harness, userId, address) {
  const id = crypto.randomUUID();
  await harness.db.prepare(`INSERT INTO mailboxes(id, user_id, provider_id, remote_id, address, status, created_at)
    VALUES (?, ?, 'synthetic-fixture', ?, ?, 'active', ?)`)
    .bind(id, userId, crypto.randomUUID(), address, Math.floor(Date.now() / 1000)).run();
  return id;
}

export async function newKey(harness, cookie, extra = {}) {
  const response = await harness.request("/api/v1/api-keys", { method: "POST", cookie,
    body: { name: "local integration", scopes: ["mailboxes:read"], ...extra } });
  assert.equal(response.status, 201, response.text);
  return response.body;
}

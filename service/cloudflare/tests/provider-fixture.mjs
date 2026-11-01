import assert from "node:assert/strict";
import { createServer } from "node:http";

// Loopback contract fixtures only. These are not delivery receipts or real provider accounts.
export async function providerFixture() {
  const calls = [];
  const mailboxes = new Map();
  const messages = new Map();
  const rawMails = new Map();
  const modes = new Map();
  const gates = new Map();
  const missingDetails = new Set();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ path: url.pathname, query: url.searchParams, method: request.method, headers: request.headers, body });
    const send = (value, status = 200) => {
      if (!response.destroyed) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }
    };
    try {
      const gate = gates.get(url.pathname);
      if (gate) { gates.delete(url.pathname); gate.enter(); await gate.wait; }
      const mode = modes.get(url.pathname);
      if (mode === "disconnect") { response.destroy(); return; }
      if (typeof mode === "number") { send({ error: "do-not-leak-secret-or-body" }, mode); return; }
      if (mode === "redirect") { response.writeHead(302, { location: "/secret-exfiltration" }); response.end(); return; }
      if (mode === "oversized") { send({ body: "x".repeat(2 * 1024 * 1024) }); return; }
      if (mode === "raw-oversized") { send({ raw: "x".repeat(8 * 1024 * 1024) }); return; }
      if (mode === "invalid") { response.writeHead(200, { "content-type": "application/json" }); response.end("not JSON"); return; }
      if (url.pathname === "/cf/admin/worker/configs") {
        assert.equal(request.headers["x-admin-auth"], "synthetic-cf-admin");
        assert.equal(request.headers["x-custom-auth"], "synthetic-site-password");
        send({ DOMAINS: ["cf.example.test"], VERSION: "synthetic-local", secret: "do-not-leak" }); return;
      }
      if (url.pathname === "/cf/admin/new_address") {
        assert.equal(request.headers["x-admin-auth"], "synthetic-cf-admin");
        assert.equal(request.headers["x-custom-auth"], "synthetic-site-password");
        assert.equal(body.enablePrefix, false);
        const address = `${body.name}@${body.domain}`;
        const token = `synthetic-mail-jwt-${mailboxes.size}`;
        mailboxes.set(address, { token, id: mailboxes.size + 1 });
        send({ address, jwt: token, address_id: mailboxes.get(address).id, password: null }); return;
      }
      if (url.pathname === "/cf/api/parsed_mails") {
        const mailbox = [...mailboxes].find(([, value]) => request.headers.authorization === `Bearer ${value.token}`);
        assert.ok(mailbox, "Use mailbox JWT, not platform admin credential");
        assert.equal(request.headers["x-admin-auth"], undefined);
        const rows = messages.get(mailbox[0]) ?? [];
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        send({ results: rows.slice(offset, offset + limit), count: offset === 0 ? rows.length : 0 }); return;
      }
      if (url.pathname.startsWith("/cf/api/mail/")) {
        const mailbox = [...mailboxes].find(([, value]) => request.headers.authorization === `Bearer ${value.token}`);
        assert.ok(mailbox); assert.equal(request.headers["x-admin-auth"], undefined);
        const rows = rawMails.get(mailbox[0]) ?? [];
        send(rows.find((row) => String(row.id) === url.pathname.split("/").at(-1)) ?? null); return;
      }
      if (url.pathname === "/cf/admin/send_mail_by_binding" || url.pathname === "/cf/api/send_mail") {
        assert.equal(request.headers["x-custom-auth"], "synthetic-site-password");
        if (url.pathname.includes("/admin/")) assert.equal(request.headers["x-admin-auth"], "synthetic-cf-admin");
        else {
          assert.equal(request.headers["x-admin-auth"], undefined);
          assert.ok([...mailboxes.values()].some((mailbox) => request.headers.authorization === `Bearer ${mailbox.token}`));
        }
        send({ status: "ok" }); return;
      }
      assert.equal(request.headers.authorization, "Bearer synthetic-temporam-key");
      if (url.pathname === "/v3/domains") { send({ code: 200, error: false, data: [{ domain: "temp.example.test" }] }); return; }
      if (url.pathname === "/v3/emails") {
        const rows = messages.get(url.searchParams.get("email")) ?? [];
        const page = Number(url.searchParams.get("page"));
        const limit = Number(url.searchParams.get("limit"));
        send({ code: 200, error: false, data: rows.slice((page - 1) * limit, page * limit).map((row) => ({ id: row.id })),
          meta: { total: rows.length, page, limit } }); return;
      }
      if (url.pathname.startsWith("/v3/emails/")) {
        const id = decodeURIComponent(url.pathname.slice("/v3/emails/".length));
        const row = [...messages.values()].flat().find((value) => String(value.id) === id);
        send({ code: 200, error: false, data: missingDetails.has(id) ? null : row ?? null }); return;
      }
      send({ error: "fixture-route-not-found" }, 404);
    } catch (error) { send({ fixtureError: error.message }, 500); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, messages, rawMails, mailboxes, modes, missingDetails,
    bindings: {
      PROVIDER_CONFIG: JSON.stringify([{ id: "self", type: "cloudflare", baseUrl: `${base}/cf`, domains: ["cf.example.test"] },
        { id: "temporam", type: "temporam", baseUrl: `${base}/v3`, domains: [] }]),
      PROVIDER_SECRETS: JSON.stringify({ self: { apiKey: "synthetic-cf-admin", sitePassword: "synthetic-site-password" }, temporam: { apiKey: "synthetic-temporam-key" } }),
      MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "a3".repeat(32) } }),
    },
    hold(path) {
      let enter, release;
      const entered = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Fixture gate not reached: ${path}`)), 10000);
        timer.unref();
        enter = () => { clearTimeout(timer); resolve(); };
      });
      const wait = new Promise((resolve) => { release = resolve; });
      gates.set(path, { enter, wait });
      return { entered, release };
    },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}

export async function allocate(h, cookie, providerId = "self", extra = {}) {
  return h.request("/api/v1/mailboxes", { method: "POST", cookie, headers: { "idempotency-key": crypto.randomUUID() },
    body: { providerId, domain: providerId === "self" ? "cf.example.test" : "temp.example.test" }, ...extra });
}

export function cfMail(address, id, text = "Your verification code is 654321.", time = "2026-10-28 01:00:00") {
  return { id, address, sender: "noreply@example.test", subject: "Verify your account", text,
    html: '<script>window.mailExecuted=true</script><a href="https://auth.example.test/verify?token=synthetic">Verify</a><a href="/login">relative</a>',
    attachments: [{ filename: "sample.txt", mimeType: "text/plain", size: 12 }], created_at: time };
}

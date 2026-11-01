import { Hono } from "hono";
import { jwt } from "hono/jwt";
import { HTTPException } from "hono/http-exception";
import { deleteAddressWithData } from "../../../upstreams/cloudflare_temp_email/worker/src/common-cleanup";
import { newAddress } from "../../../upstreams/cloudflare_temp_email/worker/src/common-address";
import { customAddressCapability, createCustomAddress } from "../../../upstreams/cloudflare_temp_email/worker/src/admin_api/custom_address";
import { withAddressGeneration } from "../../../upstreams/cloudflare_temp_email/worker/src/address-generation";
import { addressDeletionCapability, addressDeletionStatus, conditionalAddressDelete } from "../../../upstreams/cloudflare_temp_email/worker/src/mails_api/conditional_address_delete";
import { conditionalMailDelete, mailDeletionStatus } from "../../../upstreams/cloudflare_temp_email/worker/src/mails_api/conditional_delete";
import { resourceMailQuery } from "../../../upstreams/cloudflare_temp_email/worker/src/mails_api/mail_resource_schema";

type FixtureEnv = { Bindings: { DB: D1Database; JWT_SECRET: string; ENABLE_USER_DELETE_EMAIL: string };
  Variables: { jwtPayload: { address: string; address_id: number } } };
const app = new Hono<FixtureEnv>();
app.get('/admin/custom_address_capability', (c) => customAddressCapability(c as never));
app.post('/admin/custom_address', (c) => createCustomAddress(c as never));
const enabled = async (db: D1Database) => (await db.prepare("SELECT enabled FROM fixture_settings").first<{ enabled: number }>())?.enabled === 1;
app.onError((error, c) => c.json({ error: { code: error instanceof HTTPException ? "invalid_jwt" : "synthetic_handler_failure" } },
  error instanceof HTTPException ? error.status : 500));
app.post("/admin/new_address", async (c) => {
  if (c.req.header("x-admin-auth") !== "synthetic-cf-admin") return c.json({ error: "admin" }, 401);
  const input = await c.req.json();
  try {
    // The admin wrapper is local; name/domain rules, address INSERT and HS256 JWT are production code.
    const result = await newAddress(c as never, { name: input.name, domain: input.domain, enablePrefix: input.enablePrefix,
      enableRandomSubdomain: input.enableRandomSubdomain === true, checkLengthByConfig: false, addressPrefix: null,
      checkAllowDomains: false, enableCheckNameRegex: false, sourceMeta: "admin" });
    await c.env.DB.prepare("INSERT INTO fixture_credentials(token,address,address_id) VALUES(?,?,?)")
      .bind(result.jwt, result.address, result.address_id).run();
    return c.json(result);
  } catch { return c.json({ error: "synthetic admin creation rejected" }, 400); }
});
app.use("/api/*", (c, next) => jwt({ secret: c.env.JWT_SECRET, alg: "HS256" })(c, async () => {
  c.res = await withAddressGeneration(c.req.raw, c.env.DB, c.get("jwtPayload"), async () => { await next(); return c.res; });
}));
app.get("/api/mails", async (c) => c.json({ results: (await c.env.DB.prepare("SELECT * FROM raw_mails WHERE address=?")
  .bind(c.get("jwtPayload").address).all()).results }));
app.post("/api/send_mail", async (c) => { await c.env.DB.prepare("UPDATE fixture_dispatch_counter SET n=n+1").run(); return c.json({ status: "ok" }); });
app.get("/api/address_deletion_capability", async (c) => addressDeletionCapability(c.env.DB, c.get("jwtPayload"), await enabled(c.env.DB)));
app.post("/api/address_deletions", async (c) => conditionalAddressDelete(c.req.raw, c.env.DB, c.get("jwtPayload"), await enabled(c.env.DB)));
app.get("/api/address_deletions/:id", (c) => addressDeletionStatus(c.req.param("id"), c.env.DB, c.get("jwtPayload")));
app.post("/api/mail_deletions", (c) => conditionalMailDelete(c.req.raw, c.env.DB, c.get("jwtPayload"), true));
app.get("/api/mail_deletions/:id", (c) => mailDeletionStatus(c.req.param("id"), c.env.DB, c.get("jwtPayload")));
app.get("/api/parsed_mails", async (c) => {
  const { results } = await c.env.DB.prepare(`${await resourceMailQuery(c.env.DB)} WHERE r.address=? ORDER BY r.id DESC LIMIT ? OFFSET ?`)
    .bind(c.get("jwtPayload").address, Number(c.req.query("limit")), Number(c.req.query("offset"))).all<Record<string, unknown>>();
  // Parsed content is synthetic; JWT, generation guard, resource SQL and deletion handlers are production modules.
  return c.json({ results: results.map((row) => ({ ...JSON.parse(String(row.raw)), id: row.id, address: row.address,
    resource_version: row.resource_version, remote_delete_enabled: !!row.resource_version })), count: results.length });
});
app.get("/api/mail/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT id,address,raw FROM raw_mails WHERE id=? AND address=?")
    .bind(c.req.param("id"), c.get("jwtPayload").address).first<{ id: number; address: string; raw: string }>();
  return c.json(row ? { ...row, raw: JSON.parse(row.raw).fixture_raw ?? "" } : null);
});
app.get("/api/fixture/late_read", async (c) => {
  const address = c.get("jwtPayload").address;
  const { results } = await c.env.DB.prepare("SELECT * FROM raw_mails WHERE address=?").bind(address).all();
  await c.env.DB.prepare("DELETE FROM address WHERE name=?").bind(address).run();
  await c.env.DB.prepare("INSERT INTO address(name) VALUES(?)").bind(address).run();
  return c.json({ results });
});
app.get("/api/fixture/handler_error", () => { throw Error("synthetic business failure"); });
app.post("/api/fixture/legacy_cleanup", async (c) => {
  const body = await c.req.json();
  return c.json({ success: await deleteAddressWithData(c as never, body.address, body.address_id) });
});
app.delete("/api/delete_address", async (c) => {
  const claims = c.get("jwtPayload");
  // Real production cleanup; Telegram and utility imports alone are isolated by the bundle plugin.
  const success = await deleteAddressWithData(c as never, claims.address, claims.address_id);
  return c.json({ success });
});
export default app;

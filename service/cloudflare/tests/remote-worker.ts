import { conditionalMailDelete, mailDeletionStatus } from "../../../upstreams/cloudflare_temp_email/worker/src/mails_api/conditional_delete";
import { resourceMailQuery } from "../../../upstreams/cloudflare_temp_email/worker/src/mails_api/mail_resource_schema";
import { addressDeletionCapability, addressDeletionStatus, conditionalAddressDelete } from "../../../upstreams/cloudflare_temp_email/worker/src/mails_api/conditional_address_delete";

interface Env { DB: D1Database }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url), json = (value: unknown, status = 200) => Response.json(value, { status });
    if (request.headers.get("x-custom-auth") !== "synthetic-site-password") return json({ error: "site password" }, 401);
    if (url.pathname === "/cf/admin/new_address") {
      if (request.headers.get("x-admin-auth") !== "synthetic-cf-admin") return json({ error: "admin" }, 401);
      const input = await request.json() as { name: string; domain: string }, address = `${input.name}@${input.domain}`;
      const row = await env.DB.prepare("INSERT INTO address(name) VALUES(?) RETURNING id").bind(address).first<{ id: number }>();
      const token = `synthetic-mail-jwt-${crypto.randomUUID()}`;
      await env.DB.prepare("INSERT INTO fixture_credentials(token,address,address_id) VALUES(?,?,?)").bind(token, address, row!.id).run();
      return json({ address, jwt: token, address_id: row!.id });
    }
    const credential = await env.DB.prepare("SELECT address,address_id FROM fixture_credentials WHERE token=?")
      .bind((request.headers.get("authorization") ?? "").replace(/^Bearer /, "")).first<{ address: string; address_id: number }>();
    if (!credential) return json({ error: "mailbox credential" }, 401);
    const enabled = (await env.DB.prepare("SELECT enabled FROM fixture_settings").first<{ enabled: number }>())!.enabled === 1;
    const claims = request.headers.get("x-fixture-address-id-format") === "string"
      ? { ...credential, address_id: JSON.parse(request.headers.get("x-fixture-address-id-value") ?? JSON.stringify(String(credential.address_id))) } : credential;
    if (url.pathname === "/cf/api/address_deletion_capability" && request.method === "GET") return addressDeletionCapability(env.DB, claims, enabled);
    if (url.pathname === "/cf/api/address_deletions" && request.method === "POST") return conditionalAddressDelete(request, env.DB, claims, enabled);
    const addressStatus = /^\/cf\/api\/address_deletions\/([^/]+)$/.exec(url.pathname);
    if (addressStatus && request.method === "GET") return addressDeletionStatus(addressStatus[1], env.DB, claims);
    if (url.pathname === "/cf/api/mail_deletions" && request.method === "POST") return conditionalMailDelete(request, env.DB, claims, enabled);
    const status = /^\/cf\/api\/mail_deletions\/([^/]+)$/.exec(url.pathname);
    if (status && request.method === "GET") return mailDeletionStatus(status[1], env.DB, claims);
    if (url.pathname === "/cf/api/parsed_mails") {
      const { results } = await env.DB.prepare(`${await resourceMailQuery(env.DB)} WHERE r.address=? ORDER BY r.id DESC LIMIT ? OFFSET ?`)
        .bind(credential.address, Number(url.searchParams.get("limit")), Number(url.searchParams.get("offset"))).all<Record<string, unknown>>();
      // Synthetic parsed content only; conditional delete and version SQL are the actual upstream modules.
      return json({ results: results.map((row) => ({ ...JSON.parse(String(row.raw)), id: row.id, address: row.address,
        resource_version: row.resource_version, remote_delete_enabled: enabled && !!row.resource_version })), count: results.length });
    }
    return json({ error: "fixture route" }, 404);
  },
};

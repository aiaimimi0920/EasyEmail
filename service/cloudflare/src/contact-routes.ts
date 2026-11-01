import type { Env, Identity } from "./contracts";
import { HttpError, json } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { contactCommand, CONTACT_UUID } from "./contact-input";
import { contactView } from "./contact-model";
import { listContacts } from "./contact-query";
import { completedContactOperation, contactOperation, contactRow, mutateContact } from "./contact-store";

export const isContactPath = (path: string) => /^\/api\/v1\/contacts(?:\/[0-9a-f-]{36})?$/.test(path)
  || /^\/api\/v1\/contact-operations\/[0-9a-f-]{36}$/.test(path);

export async function contactRoute(request: Request, env: Env, identity: Identity) {
  const url = new URL(request.url), operation = url.pathname.startsWith("/api/v1/contact-operations/");
  const list = url.pathname === "/api/v1/contacts", id = list ? null : url.pathname.split("/").at(-1)!;
  if (id && !CONTACT_UUID.test(id)) throw new HttpError(404, "not_found");
  requireScope(identity, "contacts:read");
  if (operation) {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    requireScope(identity, "contacts:write");
    if (url.search) throw new HttpError(400, "invalid_filter");
    const row = await contactOperation(env, identity.userId, id!);
    if (!row) throw new HttpError(404, "not_found");
    return json({ operation: completedContactOperation(row) });
  }
  if (request.method === "GET") {
    if (list) return json(await listContacts(url, env, identity));
    if (url.search) throw new HttpError(400, "invalid_filter");
    const row = await contactRow(env, identity.userId, id!);
    if (!row || row.deleted_at !== null) throw new HttpError(404, "not_found");
    return json({ contact: contactView(row) });
  }
  if ((list && request.method !== "POST") || (!list && !["PATCH", "DELETE"].includes(request.method))) throw new HttpError(405, "method_not_allowed");
  requireWriteScope(request, env, identity, "contacts:write");
  if (url.search) throw new HttpError(400, "invalid_filter");
  const key = request.headers.get("idempotency-key") ?? "";
  if (!CONTACT_UUID.test(key)) throw new HttpError(400, "invalid_idempotency_key");
  const result = await mutateContact(env, identity, key, await contactCommand(request, id));
  return json(result, list && !result.replayed ? 201 : 200);
}

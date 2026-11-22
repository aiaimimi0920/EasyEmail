import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { normalAccount } from "./normal-account-store";
import { smtpConfigInput, smtpEndpoints } from "./smtp-config-input";
import { saveSmtpConfig, smtpConfig, smtpView } from "./smtp-config-store";
import { sendNormalMessage } from "./normal-send";
import { readNormalOutgoing } from "./normal-outgoing-store";

export const isNormalSendPath = (path: string) => /^\/api\/v1\/normal-accounts\/(?:smtp-endpoints|[0-9a-f-]{36}\/(?:smtp|send|outgoing))$/.test(path);
export async function normalSendRoute(request: Request, env: Env, identity: Identity) {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/smtp-endpoints") && request.method === "GET") {
    requireScope(identity, "mail-accounts:read");
    return json({ items: smtpEndpoints(env).map(({ id, label, hostname, port, security, authentication }) => ({ id, label, hostname, port, security: security ?? "tls", authentication })) });
  }
  const match = /^\/api\/v1\/normal-accounts\/([0-9a-f-]{36})\/(smtp|send|outgoing)$/.exec(path);
  if (!match) throw new HttpError(405, "method_not_allowed");
  const [, id, action] = match;
  if (action === "send" && request.method === "POST") {
    requireWriteScope(request, env, identity, "mail-accounts:send");
    return sendNormalMessage(request, env, identity, id);
  }
  if (action === "outgoing" && request.method === "GET") {
    requireScope(identity, "mail-accounts:read"); requireScope(identity, "messages:read");
    return readNormalOutgoing(request, env, identity, id);
  }
  if (action === "smtp" && request.method === "GET") {
    requireScope(identity, "mail-accounts:read");
    const account = await normalAccount(env, identity.userId, id);
    if (!account || account.deleted_at !== null) throw new HttpError(404, "not_found");
    return json({ smtp: smtpView(await smtpConfig(env, identity.userId, id), account.revision) });
  }
  if (action === "smtp" && request.method === "PUT") {
    requireWriteScope(request, env, identity, "mail-accounts:write");
    const key = request.headers.get("idempotency-key") ?? "";
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, "idempotency_key_required");
    return json(await saveSmtpConfig(env, identity, id, key, smtpConfigInput(await readJson(request))));
  }
  throw new HttpError(405, "method_not_allowed");
}

import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { assetView, OUTBOX_FILE_BYTES, OUTBOX_FILES, OUTBOX_MESSAGE_BYTES, OUTBOX_TTL } from "./outbox-model";
import { ownedAsset, reserveAsset } from "./outbox-store";
import { completeAsset, downloadAsset, uploadAsset } from "./outbox-content";
import { cleanupOutbox, removeAsset } from "./outbox-cleanup";
import { rateLimit } from "./rate-limits";

export const isOutboxPath = (path: string) => /^\/api\/v1\/outbox-attachments(?:\/(?:cleanup|[0-9a-f-]{36}(?:\/(?:content|check))?))?$/.test(path);
async function emptyBody(request: Request) { if (Object.keys(await readJson(request)).length) throw new HttpError(400, "invalid_outbox_attachment"); }
export async function outboxRoute(request: Request, env: Env, identity: Identity): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    if (request.method === "GET") requireScope(identity, "attachments:read");
    else requireWriteScope(request, env, identity, "attachments:write");
    if (path === "/api/v1/outbox-attachments") {
      if (request.method === "GET") return json({ policy: { available: !!env.OUTBOX, fileBytes: OUTBOX_FILE_BYTES,
        messageBytes: OUTBOX_MESSAGE_BYTES, maxFiles: OUTBOX_FILES, ttlSeconds: OUTBOX_TTL } });
      if (request.method === "POST") {
        const result = await reserveAsset(env, identity, request.headers.get("idempotency-key") ?? "", await readJson(request));
        return json({ attachment: assetView(result.row) }, result.created ? 201 : 200);
      }
    }
    if (path === "/api/v1/outbox-attachments/cleanup" && request.method === "POST") {
      await emptyBody(request); await rateLimit(env, "outbox-cleanup", identity.userId, 2);
      return json({ cleanup: await cleanupOutbox(env, identity.userId) });
    }
    const match = /^\/api\/v1\/outbox-attachments\/([0-9a-f-]{36})(?:\/(content|check))?$/.exec(path);
    if (match) {
      const [, id, action] = match;
      if (!action && request.method === "GET") return json({ attachment: assetView(await ownedAsset(env, identity, id)) });
      if (!action && request.method === "DELETE") {
        await emptyBody(request); const result = await removeAsset(env, identity, id);
        return json({ attachment: assetView(result.row), cleanupPending: !result.cleaned }, result.cleaned ? 200 : 202);
      }
      if (action === "content" && request.method === "GET") return await downloadAsset(env, identity, id);
      if (action === "content" && request.method === "PUT") return json({ attachment: assetView(await uploadAsset(request, env, identity, id)) });
      if (action === "check" && request.method === "POST") { await emptyBody(request); return json({ attachment: assetView(await completeAsset(env, identity, id)) }); }
    }
    throw new HttpError(405, "method_not_allowed");
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, "outbox_storage_failed"); }
}

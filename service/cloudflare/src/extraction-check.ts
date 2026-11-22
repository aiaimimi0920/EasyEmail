import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { extractionFilter, queryExtractions } from "./extraction-query";
import { ownedMailbox, syncMailboxPage } from "./mailbox-sync";

export async function checkExtractions(request: Request, env: Env, identity: Identity, mailboxId: string): Promise<Response> {
  requireScope(identity, "messages:read");
  requireWriteScope(request, env, identity, "mailboxes:write");
  const mailbox = await ownedMailbox(env, identity, mailboxId);
  const body = await readJson(request);
  if (Object.keys(body).some((key) => !["since", "sender", "subject", "recipient", "kind", "page"].includes(key))) {
    throw new HttpError(400, "invalid_extraction_request");
  }
  const filter = extractionFilter(body, mailbox.address);
  const sync = await syncMailboxPage(env, identity, mailboxId, body.page === undefined ? 1 : body.page);
  const result = await queryExtractions(env, identity, mailboxId, filter);
  return json({ ...result, sync, state: result.items.length ? "matched" : "waiting",
    retryAfterSeconds: result.items.length ? null : 5 });
}

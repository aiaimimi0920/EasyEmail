import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json } from "./http";
import { requireScope } from "./identity";
import { ownedMailbox } from "./mailbox-sync";
import { extractionResults, type ExtractionRow } from "./extraction-results";
export interface ExtractionFilter {
  since: number; sender: string; subject: string; recipient: string; kind: "any" | "otp" | "link";
}

function filterText(input: Record<string, unknown>, field: string, max: number): string {
  if (input[field] === undefined) return "";
  if (typeof input[field] !== "string" || input[field].length > max) throw new HttpError(400, "invalid_filter");
  return input[field].toLowerCase();
}

export function extractionFilter(input: Record<string, unknown>, address: string): ExtractionFilter {
  const raw = typeof input.since === "number" || typeof input.since === "string" ? String(input.since) : "";
  if (!/^\d{1,11}$/.test(raw) || Number(raw) < 1 || Number(raw) > unixNow() + 60) throw new HttpError(400, "since_required");
  const sender = filterText(input, "sender", 320), subject = filterText(input, "subject", 256);
  const recipient = input.recipient === undefined ? address : filterText(input, "recipient", 320);
  if (recipient !== address) throw new HttpError(400, "recipient_mismatch");
  const kind = input.kind === undefined ? "any" : input.kind;
  if (kind !== "any" && kind !== "otp" && kind !== "link") throw new HttpError(400, "invalid_filter");
  return { since: Number(raw), sender, subject, recipient, kind };
}

export async function queryExtractions(env: Env, identity: Identity, mailboxId: string, filter: ExtractionFilter) {
  const { results } = await env.DB.prepare(`SELECT id, sender, recipient, subject, text_body, html_body, received_at
    FROM messages WHERE user_id = ? AND mailbox_id = ? AND trashed_at IS NULL AND purged_at IS NULL AND received_at >= ? AND received_at <= ?
    ORDER BY received_at DESC, id DESC LIMIT 101`).bind(identity.userId, mailboxId, filter.since, unixNow() + 60).all<ExtractionRow>();
  return extractionResults(results, filter);
}

export async function extractMessages(request: Request, env: Env, identity: Identity, mailboxId: string): Promise<Response> {
  requireScope(identity, "messages:read");
  const mailbox = await ownedMailbox(env, identity, mailboxId);
  const filter = extractionFilter(Object.fromEntries(new URL(request.url).searchParams), mailbox.address);
  return json({ ...await queryExtractions(env, identity, mailboxId, filter),
    sync: { syncedAt: mailbox.synced_at, error: mailbox.sync_error, nextPage: mailbox.next_page } });
}

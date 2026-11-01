import { HttpError } from "./http";
import { OUTBOX_FILES, type OutboxReference } from "./outbox-model";
import { outgoingContentParts, type RecipientFields } from "./outgoing-recipients";

export function parseOutboxReferences(value: unknown): OutboxReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > OUTBOX_FILES) throw new HttpError(400, "invalid_outbox_attachment");
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(k => !["id", "version"].includes(k))
      || typeof item.id !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(item.id)
      || typeof item.version !== "string" || !/^[0-9a-f]{64}$/.test(item.version) || seen.has(item.id)) throw new HttpError(400, "invalid_outbox_attachment");
    seen.add(item.id); return { id: item.id, version: item.version };
  });
}
export function outgoingPayloadParts(mailboxId: string | null, fields: RecipientFields & { attachments?: OutboxReference[] }, subject: string, text: string, reply: string | null) {
  const parts = outgoingContentParts(mailboxId, fields, subject, text, reply);
  // The immutable resource version binds ID, filename, type, size and content digest.
  return fields.attachments?.length ? [...parts, { attachmentsVersion: 1, attachments: fields.attachments.map(({ id, version }) => ({ id, version })) }] : parts;
}
export const storedOutbox = (row: { attachments_json?: string | null }) => row.attachments_json ? JSON.parse(row.attachments_json) : [];
export function outboxFence(userId: string, references: OutboxReference[]) {
  return { sql: references.length ? references.map(() => "EXISTS (SELECT 1 FROM outbox_assets WHERE user_id=? AND id=? AND version=? AND state='ready' AND expires_at>unixepoch())").join(" AND ") : "1",
    values: references.flatMap(ref => [userId, ref.id, ref.version]) };
}
export const NO_PENDING_ASSET = `NOT EXISTS (SELECT 1 FROM outgoing_messages o, json_each(o.attachments_json) a
  WHERE o.state='pending' AND o.user_id=outbox_assets.user_id AND json_extract(a.value,'$.id')=outbox_assets.id)
  AND NOT EXISTS (SELECT 1 FROM normal_outgoing_messages n, json_each(n.attachments_json) a
    WHERE n.state='pending' AND n.user_id=outbox_assets.user_id AND json_extract(a.value,'$.id')=outbox_assets.id
      AND json_extract(a.value,'$.version')=outbox_assets.version)
  AND NOT EXISTS (SELECT 1 FROM send_jobs j, json_each(j.attachments_json) a
    WHERE j.state IN ('queued','preparing') AND j.deadline_at>unixepoch() AND j.user_id=outbox_assets.user_id
      AND json_extract(a.value,'$.id')=outbox_assets.id AND json_extract(a.value,'$.version')=outbox_assets.version)
  AND NOT EXISTS (SELECT 1 FROM normal_send_jobs j, json_each(j.attachments_json) a
    WHERE j.state IN ('queued','preparing') AND j.deadline_at>unixepoch() AND j.user_id=outbox_assets.user_id
      AND json_extract(a.value,'$.id')=outbox_assets.id AND json_extract(a.value,'$.version')=outbox_assets.version)`;

import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { outgoingView, type OutgoingRow } from "./outgoing-store";
import type { SendInput } from "./send-input";
import { normalOutgoingView, type NormalOutgoing } from "./normal-outgoing-store";
import { NORMAL_JOBS, TEMPORARY_JOBS, noJobOutgoing, type JobSource } from "./send-job-source";

interface JobRecord {
  id: string; user_id: string; request_key: string; request_hash: string;
  outgoing_key: string; outgoing_id: string | null; payload_json: string | null; attachments_json: string | null;
  draft_id: string | null; draft_revision: number | null; scheduled_at: number | null;
  due_at: number; deadline_at: number; next_attempt_at: number;
  state: "queued" | "preparing" | "submitted" | "cancelled" | "failed";
  revision: number; attempts: number; manual_retries: number; claim_token: string | null; lease_until: number | null;
  error_code: string | null; created_at: number; updated_at: number; content_purged_at: number | null;
}
export type SendJob = JobRecord & ({ mailbox_id: string; account_id?: never; account_revision?: never; smtp_revision?: never }
  | { mailbox_id?: never; account_id: string; account_revision: number; smtp_revision: number });
export type JobOutgoing = OutgoingRow | NormalOutgoing;
export const sourceForJob = (row: SendJob): JobSource => row.account_id === undefined ? TEMPORARY_JOBS : NORMAL_JOBS;
export const JOB_ACTIVE = "state IN ('queued','preparing')";
export const NO_JOB_OUTGOING = noJobOutgoing(TEMPORARY_JOBS);
export const jobByKey = (env: Env, identity: Identity, key: string, source: JobSource = TEMPORARY_JOBS) => env.DB.prepare(`SELECT * FROM ${source.table} WHERE user_id=? AND request_key=?`)
  .bind(identity.userId, key).first<SendJob>();
export async function ownedJob(env: Env, identity: Identity, id: string, source: JobSource = TEMPORARY_JOBS, accountId?: string): Promise<SendJob> {
  const row = await env.DB.prepare(`SELECT * FROM ${source.table} WHERE user_id=? AND id=? ${accountId ? "AND account_id=?" : ""}`)
    .bind(identity.userId, id, ...(accountId ? [accountId] : [])).first<SendJob>();
  if (!row) throw new HttpError(404, "not_found"); return row;
}
export async function jobOutgoing(env: Env, row: SendJob) {
  return env.DB.prepare(`SELECT * FROM ${sourceForJob(row).outgoing} WHERE user_id=? AND request_key=?`)
    .bind(row.user_id, row.outgoing_key).first<JobOutgoing>();
}
export async function jobView(env: Env, row: SendJob, detail = true, existingOutgoing?: JobOutgoing | null) {
  const outgoing = existingOutgoing === undefined ? await jobOutgoing(env, row) : existingOutgoing;
  const result = outgoing ? row.account_id === undefined ? outgoingView(outgoing as OutgoingRow, detail) : normalOutgoingView(outgoing as NormalOutgoing, detail) : null;
  const input = row.payload_json ? JSON.parse(row.payload_json) as SendInput : null;
  return { id: row.id, ...(row.account_id === undefined ? { mailboxId: row.mailbox_id }
    : { accountId: row.account_id, accountRevision: row.account_revision, smtpRevision: row.smtp_revision }), requestKey: row.request_key, revision: row.revision,
    state: result?.state ?? row.state, error: result?.error ?? row.error_code, scheduledAt: row.scheduled_at,
    dueAt: row.due_at, deadlineAt: row.deadline_at, nextAttemptAt: row.next_attempt_at,
    attempts: row.attempts, manualRetries: row.manual_retries, outgoingId: outgoing?.id ?? null,
    cancellable: !outgoing && ["queued", "preparing"].includes(row.state),
    retrySafe: !outgoing && row.state === "failed" && !!input && row.deadline_at > unixNow() && row.attempts < 5 && row.manual_retries < 3,
    delivery: "unconfirmed", subject: input?.subject ?? result?.subject ?? "",
    ...(detail ? { content: input ? { to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, text: input.text,
      replyToMessageId: input.reply, attachments: JSON.parse(row.attachments_json ?? "[]") } : null } : {}),
    draftId: row.draft_id, createdAt: row.created_at, updatedAt: row.updated_at, contentPurgedAt: row.content_purged_at };
}

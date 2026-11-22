import { HttpError } from "./http";
import { AGENT_SERVICE_UUID } from "./agent-service-model";
import { tokenHash } from "./security";

export interface AgentTaskInput {
  serviceId: string; serviceVersion: number; senderAccountId: string; accountRevision: number; smtpRevision: number;
  subject: string; text: string; confirmRestricted: boolean;
}
export function agentTaskInput(body: Record<string, unknown>): AgentTaskInput {
  const invalid = () => new HttpError(400, "invalid_agent_task_request");
  if (Object.keys(body).some(key => !["serviceId", "serviceVersion", "senderAccountId", "accountRevision", "smtpRevision", "subject", "text", "confirmRestricted"].includes(key))) throw invalid();
  for (const key of ["serviceId", "senderAccountId"]) if (typeof body[key] !== "string" || !AGENT_SERVICE_UUID.test(body[key] as string)) throw invalid();
  for (const key of ["serviceVersion", "accountRevision", "smtpRevision"]) if (!Number.isSafeInteger(body[key]) || (body[key] as number) < 1 || (body[key] as number) >= Number.MAX_SAFE_INTEGER) throw invalid();
  for (const [key, max] of [["subject", 200], ["text", 6000]] as const) {
    const value = body[key];
    if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")
      || new TextDecoder().decode(new TextEncoder().encode(value)) !== value) throw invalid();
  }
  if (/[\x00-\x1f\x7f]/.test(body.subject as string) || body.confirmRestricted !== undefined && typeof body.confirmRestricted !== "boolean") throw invalid();
  return { serviceId: body.serviceId as string, serviceVersion: body.serviceVersion as number, senderAccountId: body.senderAccountId as string,
    accountRevision: body.accountRevision as number, smtpRevision: body.smtpRevision as number, subject: body.subject as string,
    text: body.text as string, confirmRestricted: body.confirmRestricted === true };
}
export const agentTaskHash = (input: AgentTaskInput) => tokenHash(JSON.stringify(["agent-task-v1", input.serviceId, input.serviceVersion,
  input.senderAccountId, input.accountRevision, input.smtpRevision, input.subject, input.text, input.confirmRestricted]));

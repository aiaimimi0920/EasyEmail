import { HttpError, readJson } from "./http";
import { mailAddress } from "./mail-address";
import { AGENT_SERVICE_STATUSES, AGENT_TRUST_LEVELS, AGENT_SERVICE_UUID, type AgentServiceStatus, type AgentTrustLevel } from "./agent-service-model";

export interface AgentServiceFields {
  displayName?: string; emailAddress?: string; description?: string | null;
  serviceKind?: string; trustLevel?: AgentTrustLevel; status?: AgentServiceStatus;
  defaultSenderAccountId?: string | null;
}
export interface AgentServiceCommand {
  kind: "POST" | "PATCH" | "DELETE"; targetId: string | null; expectedVersion?: number; fields: AgentServiceFields;
}
const invalid = () => new HttpError(400, "invalid_agent_service_request");
export const validServiceKind = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);

export async function agentServiceCommand(request: Request, targetId: string | null): Promise<AgentServiceCommand> {
  const body = await readJson(request), kind = request.method as AgentServiceCommand["kind"], fields: AgentServiceFields = {};
  const editable = ["displayName", "description", "serviceKind", "trustLevel", "status", "defaultSenderAccountId"];
  const allowed = kind === "POST" ? [...editable, "emailAddress"] : kind === "PATCH" ? [...editable, "expectedVersion"] : ["expectedVersion"];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw invalid();
  if (Object.hasOwn(body, "defaultSenderAccountId")) {
    if (body.defaultSenderAccountId !== null && (typeof body.defaultSenderAccountId !== "string" || !AGENT_SERVICE_UUID.test(body.defaultSenderAccountId))) throw invalid();
    fields.defaultSenderAccountId = body.defaultSenderAccountId as string | null;
  }
  if (Object.hasOwn(body, "emailAddress")) {
    if (typeof body.emailAddress !== "string" || body.emailAddress.length > 512 || /[\p{Cc}\p{Cf}]/u.test(body.emailAddress)) throw invalid();
    const address = mailAddress(body.emailAddress.trim()); if (!address) throw invalid();
    fields.emailAddress = address.toLowerCase();
  }
  if (Object.hasOwn(body, "displayName")) {
    if (typeof body.displayName !== "string" || body.displayName.length > 320 || /[\p{Cc}\p{Cf}]/u.test(body.displayName)) throw invalid();
    fields.displayName = body.displayName.normalize("NFC").trim();
    if (!fields.displayName || [...fields.displayName].length > 80) throw invalid();
  }
  if (Object.hasOwn(body, "description")) {
    if (body.description !== null && (typeof body.description !== "string" || body.description.length > 2000
      || /[\p{Cc}\p{Cf}]/u.test(body.description.replace(/[\r\n\t]/g, "")))) throw invalid();
    fields.description = typeof body.description === "string" ? body.description.trim() || null : null;
  }
  if (Object.hasOwn(body, "serviceKind")) {
    if (!validServiceKind(body.serviceKind)) throw invalid(); fields.serviceKind = body.serviceKind;
  }
  if (Object.hasOwn(body, "trustLevel")) {
    if (!AGENT_TRUST_LEVELS.includes(body.trustLevel as AgentTrustLevel)) throw invalid(); fields.trustLevel = body.trustLevel as AgentTrustLevel;
  }
  if (Object.hasOwn(body, "status")) {
    if (!AGENT_SERVICE_STATUSES.includes(body.status as AgentServiceStatus)) throw invalid(); fields.status = body.status as AgentServiceStatus;
  }
  if (kind === "POST") {
    if (!fields.displayName || !fields.emailAddress) throw invalid();
    return { kind, targetId, fields: { displayName: fields.displayName, emailAddress: fields.emailAddress,
      description: fields.description ?? null, serviceKind: fields.serviceKind ?? "email_agent", trustLevel: fields.trustLevel ?? "unknown", status: fields.status ?? "active",
      ...(fields.defaultSenderAccountId !== undefined ? { defaultSenderAccountId: fields.defaultSenderAccountId } : {}) } };
  }
  if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1 || (body.expectedVersion as number) >= Number.MAX_SAFE_INTEGER
    || (kind === "PATCH" && !Object.keys(fields).length)) throw invalid();
  return { kind, targetId, expectedVersion: body.expectedVersion as number, fields };
}

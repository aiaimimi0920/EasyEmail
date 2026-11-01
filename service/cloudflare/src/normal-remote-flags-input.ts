import { HttpError } from "./http";

export interface RemoteFlagInput {
  expectedRevision: number; epochId: string; flag: "\\Seen" | "\\Flagged"; value: boolean; acknowledgedUnknownId: string | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function remoteFlagInput(body: Record<string, unknown>): RemoteFlagInput {
  if (Object.keys(body).some(key => !["expectedRevision", "epochId", "flag", "value", "acknowledgedUnknownId"].includes(key))
    || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1 || Number(body.expectedRevision) > 9007199254740990
    || typeof body.epochId !== "string" || !uuid.test(body.epochId)
    || !["\\Seen", "\\Flagged"].includes(String(body.flag)) || typeof body.flag !== "string" || typeof body.value !== "boolean"
    || (body.acknowledgedUnknownId !== undefined && body.acknowledgedUnknownId !== null
      && (typeof body.acknowledgedUnknownId !== "string" || !uuid.test(body.acknowledgedUnknownId)))) throw new HttpError(400, "invalid_remote_flags_request");
  return { expectedRevision: Number(body.expectedRevision), epochId: body.epochId, flag: body.flag as RemoteFlagInput["flag"],
    value: body.value, acknowledgedUnknownId: body.acknowledgedUnknownId as string | null ?? null };
}
export function remoteFlagKey(key: string) {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, "idempotency_key_required");
  return key;
}

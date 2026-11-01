import { HttpError } from "./http";
import { remoteFlagKey } from "./normal-remote-flags-input";

export type RemoteMutationInput = { expectedRevision: number; epochId: string } & (
  { action: "move"; destinationFolderId: string; destinationEpochId: string; confirmRemoteChange: true }
  | { action: "delete"; confirmPermanentDelete: true }
);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function remoteMutationInput(body: Record<string, unknown>): RemoteMutationInput {
  const common = ["expectedRevision", "epochId", "action"];
  const fields = body.action === "move" ? ["destinationFolderId", "destinationEpochId", "confirmRemoteChange"] : ["confirmPermanentDelete"];
  if (Object.keys(body).some(key => ![...common, ...fields].includes(key)) || !Number.isSafeInteger(body.expectedRevision)
    || Number(body.expectedRevision) < 1 || Number(body.expectedRevision) > 9007199254740990
    || typeof body.epochId !== "string" || !uuid.test(body.epochId)
    || (body.action === "move" ? typeof body.destinationFolderId !== "string" || !/^[0-9a-f]{64}$/.test(body.destinationFolderId)
      || typeof body.destinationEpochId !== "string" || !uuid.test(body.destinationEpochId) || body.confirmRemoteChange !== true
      : body.action !== "delete" || body.confirmPermanentDelete !== true)) throw new HttpError(400, "invalid_remote_mutation_request");
  return body.action === "move" ? { expectedRevision: Number(body.expectedRevision), epochId: body.epochId, action: "move",
    destinationFolderId: body.destinationFolderId as string, destinationEpochId: body.destinationEpochId as string, confirmRemoteChange: true }
    : { expectedRevision: Number(body.expectedRevision), epochId: body.epochId, action: "delete", confirmPermanentDelete: true };
}
export const remoteMutationKey = remoteFlagKey;

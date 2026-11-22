import { HttpError } from "./http";
import { AGENT_ACCOUNT_UUID } from "./agent-account-model";
import { agentTaskInput, type AgentTaskInput } from "./agent-task-input";
import { tokenHash } from "./security";

export interface AgentFollowupInput extends AgentTaskInput {
  expectedThreadRevision: number; replyToType: "task" | "followup" | "incoming"; replyToId: string; confirmUncertain: boolean;
}
export function agentFollowupInput(body: Record<string, unknown>): AgentFollowupInput {
  const { expectedThreadRevision, replyToType, replyToId, confirmUncertain, ...task } = body;
  if (!Number.isSafeInteger(expectedThreadRevision) || Number(expectedThreadRevision) < 0 || Number(expectedThreadRevision) >= Number.MAX_SAFE_INTEGER
    || !["task", "followup", "incoming"].includes(String(replyToType)) || typeof replyToId !== "string" || !AGENT_ACCOUNT_UUID.test(replyToId)
    || typeof confirmUncertain !== "boolean") throw new HttpError(400, "invalid_agent_followup_request");
  return { ...agentTaskInput(task), expectedThreadRevision: expectedThreadRevision as number,
    replyToType: replyToType as AgentFollowupInput["replyToType"], replyToId, confirmUncertain };
}
export const agentFollowupHash = (threadId: string, input: AgentFollowupInput) => tokenHash(JSON.stringify(["agent-followup-v1", threadId,
  input.serviceId, input.serviceVersion, input.senderAccountId, input.accountRevision, input.smtpRevision, input.subject, input.text,
  input.confirmRestricted, input.expectedThreadRevision, input.replyToType, input.replyToId, input.confirmUncertain]));

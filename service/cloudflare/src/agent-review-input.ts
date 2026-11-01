import { HttpError } from "./http";
import { AGENT_ACCOUNT_UUID } from "./agent-account-model";

export interface AgentReviewInput {
  accountRevision: number; epochId: string; expectedRevision: number; state: "attention" | "linked" | "dismissed"; threadId: string | null;
}
export function agentReviewInput(body: Record<string, unknown>): AgentReviewInput {
  const invalid = () => new HttpError(400, "invalid_agent_review_request");
  if (Object.keys(body).sort().join(",") !== "accountRevision,epochId,expectedRevision,state,threadId"
    || !Number.isSafeInteger(body.accountRevision) || (body.accountRevision as number) < 1 || (body.accountRevision as number) >= Number.MAX_SAFE_INTEGER
    || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0 || (body.expectedRevision as number) >= Number.MAX_SAFE_INTEGER
    || typeof body.epochId !== "string" || !AGENT_ACCOUNT_UUID.test(body.epochId) || typeof body.state !== "string" || !["attention", "linked", "dismissed"].includes(body.state)
    || (body.state === "linked" ? typeof body.threadId !== "string" || !AGENT_ACCOUNT_UUID.test(body.threadId) : body.threadId !== null)) throw invalid();
  return { accountRevision: body.accountRevision as number, epochId: body.epochId, expectedRevision: body.expectedRevision as number,
    state: body.state as AgentReviewInput["state"], threadId: body.threadId as string | null };
}

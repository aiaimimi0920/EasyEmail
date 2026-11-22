import { HttpError } from "./http";
import { normalAccountInput, normalRevision } from "./normal-account-input";

function inputError(error: unknown): never {
  if (error instanceof HttpError && error.code === "invalid_normal_account_request") throw new HttpError(400, "invalid_agent_account_request");
  throw error;
}
export function agentAccountCommand(body: Record<string, unknown>, deleting: boolean) {
  try { return normalAccountInput(body, deleting); } catch (error) { return inputError(error); }
}
export function agentAccountTestRevision(body: Record<string, unknown>) {
  if (Object.keys(body).some(key => key !== "expectedRevision")) throw new HttpError(400, "invalid_agent_account_request");
  try { return normalRevision(body); } catch (error) { return inputError(error); }
}
export type AgentAccountCommand = ReturnType<typeof agentAccountCommand>;

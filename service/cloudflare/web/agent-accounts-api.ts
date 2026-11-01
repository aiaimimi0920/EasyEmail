import { ApiError } from "./api";
import type { NormalAccount } from "./normal-accounts";

export interface AgentAccount extends Omit<NormalAccount, "deleted" | "authentication"> {
  scope: "agent"; kind: "agent_owned"; authentication: "password" | "google-oauth2";
}
export interface AgentAccountAttempt { id: string; method: "PUT" | "DELETE"; body: Record<string, unknown>; key: string; uncertain: boolean }
export interface AgentAccountReceipt { requestKey: string; accountId: string; kind: "PUT" | "DELETE"; revision: number; deleted: boolean; completedAt: number }
export function readAgentAccountReceipt(value: unknown, attempt: AgentAccountAttempt): AgentAccountReceipt {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as { operation?: unknown }).operation : null;
  const invalid = () => new ApiError(502, "agent_account_receipt_invalid");
  if (!row || typeof row !== "object" || Array.isArray(row)) throw invalid();
  const receipt = row as AgentAccountReceipt;
  if (receipt.requestKey !== attempt.key || receipt.accountId !== attempt.id || receipt.kind !== attempt.method
    || !Number.isSafeInteger(receipt.revision) || receipt.revision !== Number(attempt.body.expectedRevision) + 1
    || receipt.deleted !== (attempt.method === "DELETE") || !Number.isSafeInteger(receipt.completedAt) || receipt.completedAt < 0) throw invalid();
  return receipt;
}

export function readAgentAccountTest(value: unknown, expected: AgentAccount): AgentAccount {
  const object = (input: unknown): Record<string, unknown> | null => input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
  const root = object(value), account = object(root?.account), result = object(root?.test), inbox = object(result?.inbox);
  if (!account || !result || !inbox || account.id !== expected.id || account.revision !== expected.revision
    || account.scope !== "agent" || account.kind !== "agent_owned" || account.authentication !== (expected.authentication ?? "password")
    || account.emailAddress !== expected.emailAddress || account.username !== expected.username || account.endpointId !== expected.endpointId
    || account.enabled !== true || account.credentialConfigured !== true || result.accountRevision !== expected.revision
    || result.authenticated !== true || result.readOnly !== true || inbox.path !== "INBOX"
    || !Array.isArray(result.capabilities) || !result.capabilities.every(item => typeof item === "string")
    || typeof inbox.uidValidity !== "string" || !/^[1-9]\d{0,9}$/.test(inbox.uidValidity) || Number(inbox.uidValidity) > 4294967295
    || !Number.isSafeInteger(inbox.messages) || (inbox.messages as number) < 0 || (inbox.messages as number) > 4294967295
    || !Number.isSafeInteger(account.testedAt) || (account.testedAt as number) < 0 || account.testError !== null
    || account.inboxUidValidity !== inbox.uidValidity || account.inboxMessages !== inbox.messages) throw new ApiError(502, "agent_account_test_invalid");
  return { ...expected, testedAt: account.testedAt as number, testError: null, inboxUidValidity: inbox.uidValidity, inboxMessages: inbox.messages as number };
}

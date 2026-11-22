import { api } from "./api";
import type { NormalAccount } from "./normal-accounts";
import type { AgentAccount } from "./agent-accounts-api";
import { readAgentSenderAccount } from "./agent-sender-options";

interface GoogleReturn { state: string; code?: string; denied?: true }
function captureReturn(): GoogleReturn | null {
  const fields = new URLSearchParams(window.location.hash.slice(1));
  if (![...fields.keys()].some(key => key.startsWith("ee-google-"))) return null;
  // Capture before React effects or API calls. Never persist the code in browser storage.
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  const state = fields.get("ee-google-state"), code = fields.get("ee-google-code");
  if ([...fields.keys()].some(key => !["ee-google-state", "ee-google-code", "ee-google-denied"].includes(key) || fields.getAll(key).length !== 1)
    || !state || !/^[A-Za-z0-9_-]{43}$/.test(state) || (!!code === fields.has("ee-google-denied"))
    || (code !== null && !/^[\x21-\x7e]{1,2048}$/.test(code))) return { state: "invalid", denied: true };
  return { state, ...(code ? { code } : { denied: true as const }) };
}
type AuthorizedAccount = (NormalAccount & { scope?: undefined }) | AgentAccount;
let captured = captureReturn(), owner: string | null = null, attempt: Promise<{ account: AuthorizedAccount }> | null = null;
export const hasGoogleReturn = () => captured !== null || attempt !== null;
export function discardGoogleReturn() { captured = null; }
export function completeGoogleReturn(userId: string) {
  if (owner && owner !== userId) return Promise.reject(new Error("授权会话已变化，请重新发起 Google 授权"));
  if (attempt) return attempt;
  if (!captured || captured.state === "invalid") return Promise.reject(new Error("授权回调无效，请重新发起 Google 授权"));
  owner = userId; const body = captured; captured = null;
  // Module-level ownership survives StrictMode's effect replay. The server independently claims the state once.
  attempt = api<{ account: AuthorizedAccount }>("/oauth/google/complete", "POST", body).then(result => {
    if (result.account.scope === "agent") readAgentSenderAccount(result.account);
    return result;
  });
  return attempt;
}

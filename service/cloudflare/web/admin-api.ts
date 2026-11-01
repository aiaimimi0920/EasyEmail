export interface ProviderConfig {
  id: string; type: "cloudflare" | "temporam" | "moemail" | "gptmail" | "duckmail" | "guerrillamail" | "im215"; baseUrl: string; domains: string[];
  enabled: boolean; sendTransport?: "worker" | "binding"; sendRecipients: string[];
  authentication?: "api-key" | "anonymous";
}
export interface ProviderState {
  config: ProviderConfig; revision: number;
  secret: { source: "environment" | "stored" | "none"; configured: boolean };
  health: { state: string; checkedAt: number | null; error: string | null };
  allocation: { available: boolean; state: string; cooldownUntil: number | null; failureCount: number;
    lastError: string | null; lastSuccessAt: number | null; lastFailureAt: number | null };
}
export interface Audit {
  id: string; actorId: string; providerId: string; action: string; revision: number;
  secretAction: string | null; error: string | null; createdAt: number;
}
export interface Overview { counts: Record<string, number>; limits: Record<string, number | boolean> }
export const emptyProvider = (): ProviderConfig => ({ id: "", type: "cloudflare", baseUrl: "https://", domains: [], enabled: false, sendRecipients: [] });

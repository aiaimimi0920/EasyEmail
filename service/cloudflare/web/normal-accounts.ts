export interface NormalAccount {
  id: string; emailAddress: string; displayName: string; endpointId: string; username: string;
  credentialConfigured: boolean; enabled: boolean; revision: number; deleted: boolean;
  authentication?: "password" | "google-oauth2";
  testedAt: number | null; testError: string | null; inboxUidValidity: string | null; inboxMessages: number | null;
}
export interface ImapEndpoint { id: string; label: string; hostname: string; port: number; security?: "tls" | "starttls"; authentication?: "password" | "google-oauth2" }
export interface NormalWrite { path: string; method: "PUT" | "DELETE"; key: string; body: Record<string, unknown>; uncertain: boolean }

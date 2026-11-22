export interface NormalAccount {
  id: string; user_id: string; email_address: string; display_name: string; endpoint_id: string; endpoint_hash: string;
  username: string; credential_cipher: string | null; enabled: number; revision: number; deleted_at: number | null;
  test_token: string | null; test_lease_until: number | null; tested_at: number | null; test_error: string | null;
  inbox_uid_validity: string | null; inbox_messages: number | null; created_at: number; updated_at: number;
  authentication: "password" | "google-oauth2"; oauth_grant_id: string | null; oauth_flow_id: string | null;
}
export interface NormalOperation {
  id: string; user_id: string; request_key: string; account_id: string; request_hash: string;
  revision: number | null; deleted: number; completed_at: number | null;
}
export function normalAccountView(row: NormalAccount) {
  return { id: row.id, emailAddress: row.email_address, displayName: row.display_name, endpointId: row.endpoint_id, authentication: row.authentication,
    username: row.username, credentialConfigured: !!row.credential_cipher, enabled: row.enabled === 1, revision: row.revision,
    testedAt: row.tested_at, testError: row.test_error, inboxUidValidity: row.inbox_uid_validity, inboxMessages: row.inbox_messages,
    createdAt: row.created_at, updatedAt: row.updated_at, deleted: row.deleted_at !== null };
}

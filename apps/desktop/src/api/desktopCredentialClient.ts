import type { InvokeCommand } from "./invokeCommand";

export type DesktopCredentialRefDto = {
  secret_backend: string;
  secret_key: string;
  credential_kind: string;
  auth_method: string;
};

export interface DesktopCredentialTransport {
  storeImapPassword(secret: string): Promise<DesktopCredentialRefDto>;
  deleteCredential(secretKey: string): Promise<void>;
}

export function createDesktopCredentialClient(
  invokeCommand: InvokeCommand,
): DesktopCredentialTransport {
  return {
    storeImapPassword(secret: string): Promise<DesktopCredentialRefDto> {
      return invokeCommand<DesktopCredentialRefDto>("desktop_credential_store", {
        request: {
          credential_kind: "imap_password",
          auth_method: "password",
          secret,
        },
      });
    },
    deleteCredential(secretKey: string): Promise<void> {
      return invokeCommand<void>("desktop_credential_delete", {
        request: { secret_key: secretKey },
      });
    },
  };
}

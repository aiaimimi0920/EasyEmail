import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopCredentialClient } from "../src/api/desktopCredentialClient.ts";
import type { InvokeCommand } from "../src/api/invokeCommand.ts";

test("uses only the narrow desktop credential commands", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invokeCommand: InvokeCommand = async <T>(command, args) => {
    calls.push({ command, args });
    if (command === "desktop_credential_store") {
      return {
        secret_backend: "windows_credential_manager",
        secret_key: "ref:v1:desktop/00000000000000000000000000000001",
        credential_kind: "imap_password",
        auth_method: "password",
      } as T;
    }
    return undefined as T;
  };
  const client = createDesktopCredentialClient(invokeCommand);

  const stored = await client.storeImapPassword("desktop-only-canary");
  await client.deleteCredential(stored.secret_key);

  assert.deepEqual(calls, [
    {
      command: "desktop_credential_store",
      args: {
        request: {
          credential_kind: "imap_password",
          auth_method: "password",
          secret: "desktop-only-canary",
        },
      },
    },
    {
      command: "desktop_credential_delete",
      args: { request: { secret_key: stored.secret_key } },
    },
  ]);
});

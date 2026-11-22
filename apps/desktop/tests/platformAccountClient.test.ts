import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlatformAccountClient,
  PLATFORM_DEV_SESSION_DISABLED_ERROR,
} from "../src/api/platformAccountClient.ts";

test("unsigned platform development session is permanently disabled and returns null on startup", async () => {
  const client = createPlatformAccountClient();
  const session = await client.getPlatformAccountSession();
  assert.equal(session, null);
});

test("signInPlatformAccount and queryPlatformAccountData reject with platform_dev_session_disabled", async () => {
  const client = createPlatformAccountClient();

  await assert.rejects(
    client.signInPlatformAccount(),
    (caught: unknown) => {
      assert.deepEqual(caught, PLATFORM_DEV_SESSION_DISABLED_ERROR);
      return true;
    },
  );

  await assert.rejects(
    client.queryPlatformAccountData({ resource: "entitlements" }),
    (caught: unknown) => {
      assert.deepEqual(caught, PLATFORM_DEV_SESSION_DISABLED_ERROR);
      return true;
    },
  );
});

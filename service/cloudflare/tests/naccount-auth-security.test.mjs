import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { naccountFixture, pkcePair } from "./naccount-auth-fixture.mjs";

let f;

before(async () => {
  f = await naccountFixture();
});

beforeEach(async () => {
  f.setMode("normal");
  await f.h.resetLimits();
});

after(async () => {
  if (f) await f.close();
});

test("authorization code fence rejects duplicate replay before contacting NAccount again", async () => {
  const issued = f.issueCode({ sub: "replay-user-001", email: "replay@aiaimimi.com", roles: [] });
  const first = await f.complete(issued);
  assert.equal(first.status, 200, first.text);
  const callsAfterFirst = f.calls.length;

  const replay = await f.complete(issued);
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error.code, "naccount_code_already_used");
  assert.equal(f.calls.length, callsAfterFirst, "Replayed code must fail locally before upstream fetch");
});

test("PKCE mismatch, signature tampering, claim mismatches, redirects and JWKS rotation behave deterministically", async () => {
  const wrongPkce = f.issueCode({ sub: "pkce-user-001", email: "pkce@aiaimimi.com", roles: [] });
  const badVerifier = await f.complete({ ...wrongPkce, codeVerifier: pkcePair().verifier });
  assert.equal(badVerifier.status, 401);
  assert.equal(badVerifier.body.error.code, "naccount_code_rejected");

  for (const [mode, expectedStatus, expectedCode] of [
    ["wrong-signature", 401, "naccount_token_invalid"],
    ["wrong-iss", 401, "naccount_token_invalid"],
    ["wrong-aud", 401, "naccount_token_invalid"],
    ["expired-id-token", 401, "naccount_token_invalid"],
    ["sub-mismatch", 401, "naccount_token_invalid"],
    ["user-disabled", 403, "naccount_user_unavailable"],
    ["provider-502", 502, "naccount_provider_unavailable"],
    ["provider-redirect", 502, "naccount_provider_unavailable"],
  ]) {
    f.setMode(mode);
    const attempt = f.issueCode({ sub: `mode-${mode}`, email: `${mode}@aiaimimi.com`, roles: [] });
    const response = await f.complete(attempt);
    assert.equal(response.status, expectedStatus, `${mode}: ${response.text}`);
    assert.equal(response.body.error.code, expectedCode, mode);
  }

  f.setMode("normal");
  f.rotateSigningKey();
  const rotated = f.issueCode({ sub: "rotated-key-user", email: "rotated@aiaimimi.com", roles: [] });
  const ok = await f.complete(rotated);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.user.username, "rotated");
});

test("disabled EasyEmail accounts cannot sign in or link via NAccount, and hostile origins fail closed", async () => {
  const issued = f.issueCode({ sub: "disabled-bound-001", email: "disabled1@aiaimimi.com", roles: ["super_admin"] });
  const created = await f.complete(issued);
  assert.equal(created.status, 200);
  await f.h.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(created.body.user.id).run();

  const second = f.issueCode({ sub: "disabled-bound-001", email: "disabled1@aiaimimi.com", roles: ["super_admin"] });
  const denied = await f.complete(second);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "account_disabled");

  const unlinkedDisabledId = crypto.randomUUID();
  await f.h.db.prepare("INSERT INTO users(id, username, password_hash, status, created_at) VALUES (?, 'disabledlegacy', 'scrypt$x', 'disabled', unixepoch())")
    .bind(unlinkedDisabledId).run();
  const linkDisabled = f.issueCode({ sub: "disabled-legacy-sub", email: "disabledlegacy@aiaimimi.com", roles: [] });
  const deniedLegacy = await f.complete(linkDisabled);
  assert.equal(deniedLegacy.status, 403);
  assert.equal(deniedLegacy.body.error.code, "account_disabled");

  const valid = f.issueCode({ sub: "origin-check-001", email: "origin@aiaimimi.com", roles: [] });
  for (const hostileOrigin of [null, "https://attacker.example", `${f.h.appOrigin}.evil.example`]) {
    const blocked = await f.complete(valid, { origin: hostileOrigin });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, "origin_denied");
  }
  const wrongRedirect = await f.complete({ ...valid, redirectUri: "https://evil.example/auth/callback" });
  assert.equal(wrongRedirect.status, 400);
  assert.equal(wrongRedirect.body.error.code, "invalid_naccount_callback");
});

test("0060 migration is expand-only and missing schema rejects before contacting NAccount", async () => {
  const preMigration = await naccountFixture({ through: "0059_mailbox_access_recoveries.sql" });
  try {
    const attempt = preMigration.issueCode({ sub: "pre-0060-user", email: "pre@aiaimimi.com", roles: [] });
    const blocked = await preMigration.complete(attempt);
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.error.code, "naccount_schema_required");
    assert.equal(preMigration.calls.length, 0, "Missing 0060 schema must fail before upstream network calls");

    await preMigration.h.migrate();
    const afterMigrate = await preMigration.complete(attempt);
    assert.equal(afterMigrate.status, 200, afterMigrate.text);
  } finally {
    await preMigration.close();
  }
});

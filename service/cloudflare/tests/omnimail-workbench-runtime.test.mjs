import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { createHarness, seedMailbox } from "./runtime-harness.mjs";
import { normalAccessFixture } from "./normal-access-fixture.mjs";

const KEYRING = JSON.stringify({
  active: "k1",
  keys: { k1: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
});

test("Cloudflare Omnimail workbench routes: presets, PrivacyGuard BYOK vault, rules Dry-Run, contact merge/vCard, and ICS RSVP", async () => {
  const h = await createHarness({ MAILBOX_KEYRING: KEYRING });
  try {
    const user = await h.register("omnimail-alice");

    // 1. Provider presets catalog (excludes desktop-only muse_agent)
    const presetsRes = await h.request("/api/v1/normal-accounts/presets", { cookie: user.cookie });
    assert.equal(presetsRes.status, 200);
    assert.ok(presetsRes.body.items.some((p) => p.id === "linuxdo"));
    assert.ok(presetsRes.body.items.some((p) => p.id === "tencent_exmail"));
    assert.equal(presetsRes.body.items.some((p) => p.id === "muse_agent"), false);

    // 2. Encrypted BYOK AI config + PrivacyGuard OTP hard-block before network call
    const saveAi = await h.request("/api/v1/ai/config", {
      cookie: user.cookie,
      method: "PUT",
      body: {
        enabled: true,
        provider: "openai",
        endpointUrl: "https://api.openai.com/v1",
        modelName: "gpt-4o-mini",
        apiKey: "sk-test-secret-vault-value",
        includeSubject: true,
        requireConsent: true,
        translationEnabled: true,
        translationProvider: "byok",
        translationTargetLang: "zh-CN",
      },
    });
    assert.equal(saveAi.status, 200);
    assert.equal(saveAi.body.config.credentialConfigured, true);
    assert.equal("apiKey" in saveAi.body.config, false);

    const otpBlocked = await h.request("/api/v1/ai/analyze", {
      cookie: user.cookie,
      method: "POST",
      body: {
        task: "summary",
        subject: "Verify your login",
        text: "Your verification code is 839201. Do not share it.",
        consentConfirmed: true,
      },
    });
    assert.equal(otpBlocked.status, 422);

    // 3. Inbox rules + side-effect-free 30-day Dry-Run preview
    const mailboxId = await seedMailbox(h, user.id, "alice@example.test");
    const now = Math.floor(Date.now() / 1000);
    await h.db
      .prepare(
        `INSERT INTO messages (id, user_id, mailbox_id, remote_id, fingerprint, sender, recipient, subject, text_body, html_body, attachments, received_at, observed_at, is_read, starred, archived)
         VALUES (?, ?, ?, 'pm-1', 'fp-1', 'noreply@notifications.github.com', 'alice@example.test', 'Pull request #42 merged', 'Merged cleanly', '', '[]', ?, ?, 0, 0, 0)`,
      )
      .bind(crypto.randomUUID(), user.id, mailboxId, now, now)
      .run();

    const addRule = await h.request("/api/v1/inbox-rules", {
      cookie: user.cookie,
      method: "POST",
      body: {
        name: "GitHub Notifications",
        conditions: [{ field: "sender_domain", operator: "contains", value: "github.com" }],
        actions: { markRead: true, archive: true },
      },
    });
    assert.equal(addRule.status, 201);

    const dryRun = await h.request("/api/v1/inbox-rules/dry-run", {
      cookie: user.cookie,
      method: "POST",
      body: { windowDays: 30 },
    });
    assert.equal(dryRun.status, 200);
    assert.equal(dryRun.body.report.matchedCount, 1);
    const unchangedMsg = await h.db.prepare("SELECT is_read, archived FROM messages WHERE mailbox_id = ?").bind(mailboxId).first();
    assert.deepEqual(unchangedMsg, { is_read: 0, archived: 0 });

    // 4. Contacts vCard import -> +alias duplicate detection -> single-batch lossless merge
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Bob Builder",
      "EMAIL:bob@gmail.com",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Bob Dev",
      "EMAIL:bob+ci@gmail.com",
      "END:VCARD",
    ].join("\r\n");
    const imported = await h.request("/api/v1/contact-tools/vcard", {
      cookie: user.cookie,
      method: "POST",
      body: { vcf },
    });
    assert.equal(imported.status, 201);
    assert.equal(imported.body.importedCount, 2);

    const dups = await h.request("/api/v1/contact-tools/duplicates", { cookie: user.cookie });
    assert.equal(dups.status, 200);
    assert.equal(dups.body.groups.length, 1);
    const [primary, secondary] = dups.body.groups[0].members;
    const merged = await h.request("/api/v1/contact-tools/merge", {
      cookie: user.cookie,
      method: "POST",
      body: { primaryContactId: primary.id, secondaryContactIds: [secondary.id] },
    });
    assert.equal(merged.status, 200);
    assert.equal(merged.body.merged.mergedAliases.length, 1);

    // 5. Calendar .ics RSVP + overlap conflict detection
    const ics1 = [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:slot-1@example.test",
      "DTSTART:20261210T100000Z",
      "DTEND:20261210T110000Z",
      "SUMMARY:Sprint Review",
      "ORGANIZER:mailto:pm@example.test",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const rsvp1 = await h.request("/api/v1/calendar/rsvp", {
      cookie: user.cookie,
      method: "POST",
      body: { ics: ics1, responderEmail: "alice@example.test", decision: "accepted" },
    });
    assert.equal(rsvp1.status, 200);
    assert.match(rsvp1.body.replyDraft.icsContent, /METHOD:REPLY/);

    const icsOverlap = ics1.replace("UID:slot-1@example.test", "UID:slot-2@example.test").replace("Sprint Review", "Urgent Sync");
    const parsedOverlap = await h.request("/api/v1/calendar/parse", {
      cookie: user.cookie,
      method: "POST",
      body: { ics: icsOverlap, selfEmail: "alice@example.test" },
    });
    assert.equal(parsedOverlap.status, 200);
    assert.equal(parsedOverlap.body.conflict.hasConflict, true);
    assert.equal(parsedOverlap.body.conflict.conflictingTitle, "Sprint Review");
  } finally {
    await h.close();
  }
});

test("Cloudflare Normal IMAP message detail exposes Authentication-Results and Reply-To security headers", async () => {
  const rawPhish = new TextEncoder().encode([
    'From: "Support <support@paypal.com>" <attacker@evil-domain.test>',
    "Reply-To: collector@reply-hijack.test",
    "To: alice@example.test",
    "Subject: Account check",
    "Authentication-Results: mx.example.test; spf=fail; dkim=fail; dmarc=fail",
    "Message-ID: <phish-check-1@example.test>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Verify urgently.",
  ].join("\r\n"));
  const t = await normalAccessFixture({ messages: new Map([[1, rawPhish]]), uidNext: 2 });
  try {
    assert.equal((await t.receive()).status, 200);
    const id = (await t.messages()).body.items[0].id;
    const detail = await t.message(id);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body.message.authenticationResults, "mx.example.test; spf=fail; dkim=fail; dmarc=fail");
    assert.equal(detail.body.message.replyAddress, "collector@reply-hijack.test");
  } finally {
    await t.close();
  }
});

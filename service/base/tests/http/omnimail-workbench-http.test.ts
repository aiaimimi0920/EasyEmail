import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { resolveRelationalDatabasePath } from "../../src/persistence/relational/database.js";
import { loadEasyEmailServiceRuntimeConfigFromEnvironment } from "../../src/runtime/config.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";

const API_KEY = "omnimail-http-durability-key-0123456789abcdef";
const AUTH = { authorization: `Bearer ${API_KEY}` };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

async function writeRuntimeConfig(root: string): Promise<string> {
  const configPath = join(root, "config.yaml");
  const stateFile = join(root, "state.json").replaceAll("\\", "/");
  await writeFile(
    configPath,
    [
      "server:",
      "  host: 127.0.0.1",
      "  port: 0",
      `  apiKey: "${API_KEY}"`,
      "maintenance:",
      "  enabled: false",
      "persistence:",
      "  enabled: true",
      "  driver: file",
      `  filePath: "${stateFile}"`,
      "",
    ].join("\n"),
    "utf8",
  );
  return configPath;
}

describe("Omnimail Workbench HTTP & SQLite v13 Restart Durability", () => {
  it("persists encrypted BYOK settings, rules Dry-Run/Apply, +alias contact merges, and ICS RSVPs across runtime restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "ee-omnimail-http-"));
    const configPath = await writeRuntimeConfig(root);
    const config = await loadEasyEmailServiceRuntimeConfigFromEnvironment({
      EASY_EMAIL_CONFIG_PATH: configPath,
      EASY_EMAIL_STATE_DIR: root,
    });

    const runtime1 = await startEasyEmailServiceRuntime({
      config,
      sendQueueWorkerEnabled: false,
    });

    try {
      const base = runtime1.server.baseUrl;

      // 1. Presets + Linux.do detection + local Muse catalog presence
      const presetRes = await fetch(`${base}/mail/provider-presets?email=alice@linux.do`, {
        headers: AUTH,
      });
      expect(presetRes.status).toBe(200);
      const presetJson = (await presetRes.json()) as {
        presets: Array<{ id: string }>;
        detected?: { preset: { id: string; defaultImapHost: string } | null };
      };
      expect(presetJson.detected?.preset?.id).toBe("linuxdo");
      expect(presetJson.detected?.preset?.defaultImapHost).toBe("mail.linux.do");
      expect(presetJson.presets.some((p) => p.id === "muse_agent")).toBe(true);

      // 2. Save BYOK AI settings (secret encrypted at rest, redacted in response) + OTP PrivacyGuard block
      const aiPut = await fetch(`${base}/mail/ai/settings`, {
        method: "PUT",
        headers: JSON_AUTH,
        body: JSON.stringify({
          enabled: true,
          provider: "deepseek",
          endpointUrl: "https://api.deepseek.com/v1",
          modelName: "deepseek-chat",
          apiKey: "sk-local-durability-secret-999",
          translationEnabled: true,
          translationTargetLang: "zh-CN",
        }),
      });
      expect(aiPut.status).toBe(200);
      const aiBody = (await aiPut.json()) as {
        settings: { enabled: boolean; credentialConfigured: boolean; modelName: string; apiKey?: string };
      };
      expect(aiBody.settings.enabled).toBe(true);
      expect(aiBody.settings.credentialConfigured).toBe(true);
      expect("apiKey" in aiBody.settings).toBe(false);

      const otpRes = await fetch(`${base}/mail/ai/analyze`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          task: "summary",
          subject: "安全验证",
          text: "您的登录验证码为 492817，5 分钟内有效。",
          consentConfirmed: true,
        }),
      });
      expect(otpRes.status).toBeGreaterThanOrEqual(400);

      // 3. Seed account & messages -> Dry-Run -> Apply rules -> Candidate extraction
      const acctRes = await fetch(`${base}/mail/accounts`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          kind: "normal_long_lived",
          displayName: "Local Box",
          primaryAddress: "local@example.com",
          providerLabel: "Custom",
        }),
      });
      expect(acctRes.status).toBe(200);
      const { account } = (await acctRes.json()) as { account: { id: string } };

      const nowIso = new Date().toISOString();
      const ghMsg = await runtime1.mailMessageRepository!.ingestMailMessage({
        accountId: account.id,
        sourceKind: "imap",
        sourceRefId: "imap:gh:101",
        receivedAddress: "local@example.com",
        providerLabel: "Custom",
        lifecycleState: "ready",
        fromName: "GitHub",
        fromAddress: "notifications@github.com",
        subject: "[EasyEmail] PR #88 ready",
        snippet: "All checks green",
        bodyText: "All checks green",
        classification: "general",
        observedAt: nowIso,
        now: nowIso,
      });
      await runtime1.mailMessageRepository!.ingestMailMessage({
        accountId: account.id,
        sourceKind: "imap",
        sourceRefId: "imap:human:102",
        receivedAddress: "local@example.com",
        providerLabel: "Custom",
        lifecycleState: "ready",
        fromName: "Grace Hopper",
        fromAddress: "grace@navy.example",
        subject: "Compiler notes",
        snippet: "Attached draft",
        bodyText: "Attached draft",
        classification: "general",
        observedAt: nowIso,
        now: nowIso,
      });

      const addRule = await fetch(`${base}/mail/rules`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          name: "GitHub Auto Archive",
          conditions: [{ field: "sender_domain", operator: "contains", value: "github.com" }],
          actions: { markRead: true, star: true, archive: true },
        }),
      });
      expect(addRule.status).toBe(200);

      const dryRun = await fetch(`${base}/mail/rules/dry-run`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ windowDays: 30 }),
      });
      expect(dryRun.status).toBe(200);
      const dryRunBody = (await dryRun.json()) as { report: { matchedCount: number } };
      expect(dryRunBody.report.matchedCount).toBe(1);

      const beforeRes = await fetch(`${base}/mail/messages/${ghMsg.messageId}`, { headers: AUTH });
      const beforeApply = (await beforeRes.json()) as {
        message: { isRead: boolean; isStarred: boolean; localFolder: string };
      };
      expect(beforeApply.message.isRead).toBe(false);
      expect(beforeApply.message.localFolder).toBe("inbox");

      const applyRes = await fetch(`${base}/mail/rules/apply`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ windowDays: 30 }),
      });
      expect(applyRes.status).toBe(200);
      const applyBody = (await applyRes.json()) as { appliedCount: number };
      expect(applyBody.appliedCount).toBe(1);

      const afterRes = await fetch(`${base}/mail/messages/${ghMsg.messageId}`, { headers: AUTH });
      const afterApply = (await afterRes.json()) as {
        message: { isRead: boolean; isStarred: boolean; localFolder: string };
      };
      expect(afterApply.message.isRead).toBe(true);
      expect(afterApply.message.isStarred).toBe(true);
      expect(afterApply.message.localFolder).toBe("archive");

      const candRes = await fetch(`${base}/mail/contact-tools/candidates`, { headers: AUTH });
      expect(candRes.status).toBe(200);
      const candBody = (await candRes.json()) as {
        candidates: Array<{ displayName: string; emailAddress: string }>;
      };
      expect(candBody.candidates.some((c) => c.emailAddress === "grace@navy.example")).toBe(true);

      // 4. vCard import + +alias duplicate merge
      const vcf = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:Linus Torvalds",
        "EMAIL:linus@gmail.com",
        "END:VCARD",
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:Linus Kernel",
        "EMAIL:linus+kernel@gmail.com",
        "END:VCARD",
      ].join("\r\n");
      const vcfRes = await fetch(`${base}/mail/contact-tools/vcard`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ vcf }),
      });
      expect(vcfRes.status).toBe(200);

      const dupRes = await fetch(`${base}/mail/contact-tools/duplicates`, { headers: AUTH });
      const dupBody = (await dupRes.json()) as {
        groups: Array<{ members: Array<{ id: string }> }>;
      };
      expect(dupBody.groups.length).toBe(1);
      const [primary, secondary] = dupBody.groups[0]!.members;
      const mergeRes = await fetch(`${base}/mail/contact-tools/merge`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          primaryContactId: primary!.id,
          secondaryContactIds: [secondary!.id],
        }),
      });
      expect(mergeRes.status).toBe(200);

      // 5. Calendar RSVP persisted to SQLite
      const ics1 = [
        "BEGIN:VCALENDAR",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "UID:durability-slot-1@example.com",
        "DTSTART:20261215T090000Z",
        "DTEND:20261215T100000Z",
        "SUMMARY:Architecture Sync",
        "ORGANIZER:mailto:lead@example.com",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
      const rsvpRes = await fetch(`${base}/mail/calendar/rsvp`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          ics: ics1,
          responderEmail: "local@example.com",
          decision: "accepted",
        }),
      });
      expect(rsvpRes.status).toBe(200);

      await runtime1.close();

      // Verify raw SQLite column stores encrypted ciphertext rather than plaintext API key
      const dbPath = resolveRelationalDatabasePath(config.persistence.databasePath);
      const rawDb = new DatabaseSync(dbPath);
      const rawRow = rawDb
        .prepare("SELECT credential_ref_key FROM mail_ai_settings WHERE id = 1")
        .get() as { credential_ref_key: string } | undefined;
      rawDb.close();
      expect(rawRow?.credential_ref_key.startsWith("enc:v1:")).toBe(true);
      expect(rawRow?.credential_ref_key.includes("sk-local-durability-secret-999")).toBe(false);

      // Restart runtime against the same SQLite database and verify full state hydration
      const runtime2 = await startEasyEmailServiceRuntime({
        config,
        sendQueueWorkerEnabled: false,
      });
      try {
        const base2 = runtime2.server.baseUrl;
        const aiAfter = (await (
          await fetch(`${base2}/mail/ai/settings`, { headers: AUTH })
        ).json()) as {
          settings: { enabled: boolean; credentialConfigured: boolean; modelName: string };
        };
        expect(aiAfter.settings.enabled).toBe(true);
        expect(aiAfter.settings.credentialConfigured).toBe(true);
        expect(aiAfter.settings.modelName).toBe("deepseek-chat");

        const rulesAfter = (await (
          await fetch(`${base2}/mail/rules`, { headers: AUTH })
        ).json()) as { items: Array<{ name: string }> };
        expect(rulesAfter.items.map((r) => r.name)).toContain("GitHub Auto Archive");

        const exportedVcf = (await (
          await fetch(`${base2}/mail/contact-tools/vcard`, { headers: AUTH })
        ).json()) as { vcf: string; count: number };
        expect(exportedVcf.count).toBe(1);
        expect(exportedVcf.vcf).toContain("linus@gmail.com");
        expect(exportedVcf.vcf).toContain("linus+kernel@gmail.com");

        const overlapIcs = ics1
          .replace("UID:durability-slot-1@example.com", "UID:durability-slot-2@example.com")
          .replace("Architecture Sync", "Emergency Triage");
        const overlapCheck = (await (
          await fetch(`${base2}/mail/calendar/parse`, {
            method: "POST",
            headers: JSON_AUTH,
            body: JSON.stringify({ ics: overlapIcs, selfEmail: "local@example.com" }),
          })
        ).json()) as { conflict: { hasConflict: boolean; conflictingTitle?: string } };
        expect(overlapCheck.conflict.hasConflict).toBe(true);
        expect(overlapCheck.conflict.conflictingTitle).toBe("Architecture Sync");
      } finally {
        await runtime2.close();
      }
    } finally {
      await runtime1.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
});

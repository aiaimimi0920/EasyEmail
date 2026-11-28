import { describe, expect, it } from "vitest";
import {
  buildMailProbeAdvice,
  buildRfc2971ImapIdCommandArgs,
  detectMailProviderPreset,
  listMailProviderPresets,
  normalizeProviderAppSecret,
  shouldSendRfc2971ImapId,
} from "../src/domain/mail-provider-presets.js";
import {
  decodeMailHeaderTextWithFallback,
  repairRawMimeHeaderCharsetBytes,
} from "../src/domain/mail-charset-fallback.js";
import {
  buildSandboxedReaderDocument,
  restoreSafeRemoteImagesInHtml,
  sanitizeSafeMailHtml,
} from "../src/domain/mail-safe-html-engine.js";
import {
  evaluateMailPhishingSecurity,
  inspectExternalLinkSafety,
} from "../src/domain/mail-phishing-evaluator.js";
import {
  analyzeRgbaSurfacePixels,
  resolveLightboxSurfaceBackdrop,
} from "../src/domain/mail-image-surface.js";
import {
  createTextNodeTranslationController,
  extractTranslatableTextSegments,
} from "../src/domain/mail-dom-translation.js";
import {
  evaluateMailPrivacyGuard,
} from "../src/domain/mail-ai-privacy-guard.js";
import {
  evaluateInboxRulesDryRun,
  isSenderBlockedByDomainRule,
} from "../src/domain/mail-inbox-rules.js";
import {
  canonicalizePlusAliasEmail,
  detectContactDuplicateGroups,
  parseVCardContacts,
  planLosslessContactMerge,
  serializeContactsToVCard,
} from "../src/domain/mail-contact-tools.js";
import {
  buildIcsMethodReply,
  detectCalendarEventConflict,
  parseIcsMeetingInvite,
} from "../src/domain/mail-ics-calendar.js";

describe("OmniMail-inspired shared domain engines", () => {
  it("resolves 18+ provider presets, Linux.do, NetEase RFC2971 ID, and enterprise MX hosts", () => {
    expect(listMailProviderPresets(true).length).toBeGreaterThanOrEqual(18);
    expect(listMailProviderPresets(false).some((item) => item.id === "muse_agent")).toBe(false);

    const linuxdo = detectMailProviderPreset("geek@linux.do");
    expect(linuxdo?.id).toBe("linuxdo");
    expect(linuxdo?.defaultImapHost).toBe("mail.linux.do");

    const netease126 = detectMailProviderPreset("user@126.com");
    expect(netease126?.defaultImapHost).toBe("imap.126.com");
    expect(shouldSendRfc2971ImapId("imap.163.com", [])).toBe(true);
    expect(shouldSendRfc2971ImapId("imaphz.qiye.163.com", [])).toBe(true);
    expect(buildRfc2971ImapIdCommandArgs("EasyEmail", "1.0.0")).toContain('"name" "EasyEmail"');

    const lark = detectMailProviderPreset("staff@acme.io", [
      { exchange: "mx1.larksuite.com.", priority: 10 },
    ]);
    expect(lark?.id).toBe("feishu");
    expect(lark?.defaultImapHost).toBe("imap.larksuite.com");

    expect(normalizeProviderAppSecret("user@gmail.com", "abcd efgh ijkl mnop")).toBe("abcdefghijklmnop");
    expect(buildMailProbeAdvice("imap", "qq")).toContain("授权码");
  });

  it("decodes bare GB18030 header bytes and RFC2047 CJK aliases without mojibake", () => {
    // "账单通知" in GB18030: D5 CB B5 A5 CD A8 D6 AA
    const gbBytes = Uint8Array.from([0xd5, 0xcb, 0xb5, 0xa5, 0xcd, 0xa8, 0xd6, 0xaa]);
    expect(decodeMailHeaderTextWithFallback(gbBytes)).toBe("账单通知");

    const rawHeaderPrefix = new TextEncoder().encode("From: billing@qq.com\r\nSubject: ");
    const rawBodySuffix = new TextEncoder().encode("\r\nContent-Type: text/plain; charset=gbk\r\n\r\nHello");
    const rawMime = new Uint8Array(rawHeaderPrefix.length + gbBytes.length + rawBodySuffix.length);
    rawMime.set(rawHeaderPrefix, 0);
    rawMime.set(gbBytes, rawHeaderPrefix.length);
    rawMime.set(rawBodySuffix, rawHeaderPrefix.length + gbBytes.length);

    const repaired = new TextDecoder("utf-8").decode(repairRawMimeHeaderCharsetBytes(rawMime));
    expect(repaired).toContain("Subject: 账单通知");
  });

  it("sanitizes HTML/CSS with reversible remote image stashing, CID mapping, and non-black themes", () => {
    const raw = `
      <!--[if mso]><script>evil()</script><![endif]-->
      <style>@media (prefers-color-scheme: dark) { .card { color: #e2e8f0; background: url(https://track.example/bg.png); } }</style>
      <table border="1"><tr><td colspan="2">
        <img src="cid:<hero@mail>" alt="Hero" />
        <img src="https://cdn.example/banner.png" width="320" height="120" />
        <img src="https://track.example/open.gif" width="1" height="1" />
        <a href="https://linux.do/t/1" onclick="evil()">Read</a>
      </td></tr></table>
    `;
    const result = sanitizeSafeMailHtml(raw, { cidUrlMap: { "hero@mail": "blob:cid-hero" } });
    expect(result.html).not.toContain("evil()");
    expect(result.html).toContain('colspan="2"');
    expect(result.html).toContain('src="blob:cid-hero"');
    expect(result.html).toContain('data-ee-remote-src="https://cdn.example/banner.png"');
    expect(result.trackingPixelCount).toBe(1);
    expect(result.css).toContain('data-ee-reader-scheme="adaptive-dark"');

    const restored = restoreSafeRemoteImagesInHtml(result.html);
    expect(restored).toContain('src="https://cdn.example/banner.png"');

    const doc = buildSandboxedReaderDocument({ html: result.html, css: result.css, schemeMode: "paper-light" });
    expect(doc).toContain("#F5F2EB");
    expect(doc).not.toContain("#000000");

    // Re-sanitizing already-sanitized HTML (e.g. DB read mapper -> UI reader) must remain idempotent
    // and preserve remote-image / tracking-pixel / CID markers so opt-in reveal still works.
    const secondPass = sanitizeSafeMailHtml(`<style>${result.css}</style>${result.html}`, {
      allowRemoteImages: false,
    });
    expect(secondPass.hasRemoteImages).toBe(true);
    expect(secondPass.remoteImageCount).toBe(1);
    expect(secondPass.trackingPixelCount).toBe(1);
    expect(secondPass.html).toContain('data-ee-remote-src="https://cdn.example/banner.png"');
    expect(secondPass.html).toContain('data-ee-tracking-blocked="1"');
    expect(secondPass.html).toContain('data-ee-cid="hero@mail"');
    expect(secondPass.referencedCids).toEqual(["hero@mail"]);
    expect(restoreSafeRemoteImagesInHtml(secondPass.html)).toContain('src="https://cdn.example/banner.png"');
    expect(restoreSafeRemoteImagesInHtml(secondPass.html)).not.toContain("open.gif");
  });

  it("evaluates 6-dimensional DMARC-aligned phishing signals without false positives on forwarded mail", () => {
    const forwardedPass = evaluateMailPhishingSecurity({
      senderHeader: "GitHub <noreply@github.com>",
      authenticationResultsHeader: "mx.example; spf=fail; dkim=pass; dmarc=pass",
      htmlBody: '<a href="https://github.com/pulls">https://github.com/pulls</a>',
    });
    expect(forwardedPass.level).toBe("safe");

    const spoofed = evaluateMailPhishingSecurity({
      senderHeader: '"support@paypal.com" <attacker@evil-login.org>',
      authenticationResultsHeader: "mx.example; spf=fail; dkim=fail; dmarc=fail",
      htmlBody: '<a href="https://xn--pypal-4ve.com">https://paypal.com/login</a>',
      attachmentFilenames: ["statement.pdf.exe"],
    });
    expect(spoofed.level).toBe("danger");
    expect(spoofed.reasons.length).toBeGreaterThanOrEqual(4);

    const extLink = inspectExternalLinkSafety("https://sub.linux.do/topic", ["linux.do"]);
    expect(extLink.requiresConfirmation).toBe(false);
    expect(inspectExternalLinkSafety("https://untrusted.example/path", ["linux.do"]).requiresConfirmation).toBe(true);
  });

  it("analyzes RGBA transparency for Lightbox and performs text-node-only bilingual DOM translation", () => {
    const darkLogoPixels = new Uint8Array(16 * 4);
    // Half transparent, half dark ink (r=20,g=25,b=30,a=255)
    for (let i = 0; i < 8; i += 1) darkLogoPixels[i * 4 + 3] = 0;
    for (let i = 8; i < 16; i += 1) {
      darkLogoPixels[i * 4] = 20;
      darkLogoPixels[i * 4 + 1] = 25;
      darkLogoPixels[i * 4 + 2] = 30;
      darkLogoPixels[i * 4 + 3] = 255;
    }
    const analysis = analyzeRgbaSurfacePixels(darkLogoPixels, 180, 60);
    expect(analysis.recommendedMat).toBe("light");
    const backdrop = resolveLightboxSurfaceBackdrop({ manualChoice: null, analysis });
    expect(backdrop.matBackgroundCss).toBe("#F5F2EB");

    const segments = extractTranslatableTextSegments({ htmlBody: "<p>Hello team</p><code>const x = 1;</code>" });
    expect(segments).toEqual(["Hello team"]);

    const children: Array<{ className: string; lang: string; textContent: string | null; remove: () => void }> = [];
    const fakeTextNode = {
      data: "Hello team",
      parentElement: {
        className: "", lang: "", textContent: "Hello team", parentElement: null,
        ownerDocument: null as never,
        getAttribute: () => null,
        closest: () => null,
        remove: () => undefined,
      },
      after: (el: { className: string; lang: string; textContent: string | null; remove: () => void }) => {
        children.push(el);
      },
    };
    let walked = false;
    const fakeRoot = {
      className: "ee-mail-root",
      lang: "en",
      textContent: "Hello team",
      parentElement: null,
      getAttribute: () => null,
      closest: () => null,
      remove: () => undefined,
      ownerDocument: {
        createElement: () => ({
          className: "", lang: "", textContent: null, parentElement: null,
          ownerDocument: null as never, getAttribute: () => null, closest: () => null,
          remove: () => { children.length = 0; },
        }),
        createTreeWalker: () => ({
          currentNode: fakeTextNode,
          nextNode: () => {
            if (walked) return null;
            walked = true;
            return fakeTextNode;
          },
        }),
      },
    };
    const render = createTextNodeTranslationController(fakeRoot);
    render({ mode: "bilingual", targetLang: "zh-CN", segments: { "Hello team": "团队你好" } });
    expect(fakeTextNode.data).toBe("Hello team");
    expect(children[0]?.textContent).toBe("团队你好");
    render({ mode: "translated", targetLang: "zh-CN", segments: { "Hello team": "团队你好" } });
    expect(fakeTextNode.data).toBe("团队你好");
    expect(children.length).toBe(0);
  });

  it("enforces 5-step PrivacyGuard hard-blocking OTPs and redacting cloud PII", () => {
    const blockedOtp = evaluateMailPrivacyGuard(
      { enabled: true, provider: "openai", endpointUrl: "https://api.openai.com/v1" },
      { subject: "Login verification", textBody: "Your verification code is 849201.", consentConfirmed: true },
    );
    expect(blockedOtp.allowed).toBe(false);
    if ("code" in blockedOtp) expect(blockedOtp.code).toBe("SENSITIVE_MAIL_BLOCKED");

    const needsConsent = evaluateMailPrivacyGuard(
      { enabled: true, provider: "openai", endpointUrl: "https://api.openai.com/v1", requireExplicitConsent: true },
      { subject: "Weekly sync", textBody: "Contact 13812345678 or alice@example.com for Q4 report.", consentConfirmed: false },
    );
    expect(needsConsent.allowed).toBe(false);
    if ("code" in needsConsent) expect(needsConsent.code).toBe("CONSENT_REQUIRED");

    const redactedAllowed = evaluateMailPrivacyGuard(
      { enabled: true, provider: "openai", endpointUrl: "https://api.openai.com/v1", requireExplicitConsent: true },
      { subject: "Weekly sync", textBody: "Contact 13812345678 or alice@example.com for Q4 report.", consentConfirmed: true },
    );
    expect(redactedAllowed.allowed).toBe(true);
    if ("sanitizedText" in redactedAllowed) {
      expect(redactedAllowed.sanitizedText).toContain("[REDACTED_PHONE]");
      expect(redactedAllowed.sanitizedText).toContain("[REDACTED_EMAIL]");
      expect(redactedAllowed.redactedCount).toBe(2);
    }
  });

  it("runs 30-day rule Dry-Run, merges +alias contacts with vCard, and generates ICS RSVP replies", () => {
    const nowMs = Date.now();
    const dryRun = evaluateInboxRulesDryRun(
      [{
        id: "r1", name: "GitHub PRs", enabled: false, priority: 10, matchMode: "all", stopMatching: true,
        conditions: [{ field: "sender_domain", operator: "contains", value: "github.com" }],
        actions: { addLabelIds: ["lbl-dev"], markRead: true },
      }],
      [
        { id: "m1", sender: "noreply@notifications.github.com", subject: "PR #42", receivedAtMs: nowMs - 1000 },
        { id: "m-old", sender: "noreply@github.com", subject: "Old PR", receivedAtMs: nowMs - 45 * 86400 * 1000 },
      ],
      { nowMs, includeDisabledDraftRule: true },
    );
    expect(dryRun.scannedCount).toBe(1);
    expect(dryRun.matchedCount).toBe(1);
    expect(isSenderBlockedByDomainRule("spam@sub.bad.org", ["bad.org"])).toBe(true);

    expect(canonicalizePlusAliasEmail("Alice.Smith+newsletter@googlemail.com")).toBe("alicesmith@gmail.com");
    const dupGroups = detectContactDuplicateGroups([
      { id: "c1", displayName: "Alice", emailAddress: "alice@example.com" },
      { id: "c2", displayName: "Alice Work", emailAddress: "alice+dev@example.com", notes: "Backend lead" },
    ]);
    expect(dupGroups.length).toBe(1);
    const mergePlan = planLosslessContactMerge(dupGroups[0]!.members[0]!, [dupGroups[0]!.members[1]!]);
    expect(mergePlan.mergedAliases).toEqual(["alice+dev@example.com"]);
    const vcf = serializeContactsToVCard([{
      displayName: mergePlan.mergedDisplayName,
      emailAddress: mergePlan.primaryEmailAddress,
      aliases: mergePlan.mergedAliases,
      notes: mergePlan.mergedNotes,
    }]);
    expect(parseVCardContacts(vcf)[0]?.aliases).toEqual(["alice+dev@example.com"]);

    const rawIcs = [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:evt-9001@example.com",
      "SEQUENCE:2",
      "DTSTART:20261201T090000Z",
      "DTEND:20261201T100000Z",
      "SUMMARY:Architecture Review",
      "ORGANIZER;CN=Lead:mailto:lead@example.com",
      "ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION:mailto:me@example.com",
      "DESCRIPTION:Join at https://meet.google.com/abc-defg-hij",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const invite = parseIcsMeetingInvite(rawIcs, "me@example.com");
    expect(invite?.meetingUrl).toBe("https://meet.google.com/abc-defg-hij");
    const conflict = detectCalendarEventConflict(invite!, [{
      uid: "other-evt",
      title: "Daily Standup",
      startAtMs: Date.UTC(2026, 11, 1, 9, 30, 0),
      endAtMs: Date.UTC(2026, 11, 1, 10, 15, 0),
      status: "accepted",
    }]);
    expect(conflict.hasConflict).toBe(true);
    const reply = buildIcsMethodReply({ invite: invite!, responderEmail: "me@example.com", decision: "accepted" });
    expect(reply.icsContent).toContain("METHOD:REPLY");
    expect(reply.icsContent).toContain("PARTSTAT=ACCEPTED");
  });

  it("blocks remote images with unbalanced quotes, protocol-relative URLs, and CSS backgrounds by default", () => {
    const raw = `
      <style>.hero { background: url(https://cdn.example/css-bg.png); }</style>
      <table background="https://cdn.example/table-bg.png">
        <tr><td style="background: url(https://cdn.example/inline-bg.png); background-image: url(https://cdn.example/bg-img.png)">
          <img src="https://cdn.example/unbalanced.png" alt="unclosed>
          <img src="//cdn.example/proto.png" width="120" height="60" alt="Proto" />
          <img src="https://track.example/pixel.gif" width="1" height="1" />
          <img src="data:image/png;base64,iVBORw0KGgo=" alt="Inline" />
        </td></tr>
      </table>
    `;
    const blocked = sanitizeSafeMailHtml(raw, { allowRemoteImages: false });
    expect(blocked.hasRemoteImages).toBe(true);
    expect(blocked.remoteImageCount).toBeGreaterThanOrEqual(5);
    expect(blocked.trackingPixelCount).toBe(1);
    expect(blocked.html).not.toMatch(/\ssrc="https?:/i);
    expect(blocked.html).not.toMatch(/\ssrc="\/\//i);
    expect(blocked.html).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(blocked.css).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(blocked.html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(blocked.html).toContain('data-ee-remote-src="https://cdn.example/proto.png"');
    expect(blocked.html).toContain('data-ee-remote-src="https://cdn.example/unbalanced.png"');
  });
});

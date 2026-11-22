import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { classifyImapFolderKind } from "../../src/service/imap-folder-classifier.js";
import {
  extractStructuredMimeHeaders,
  parseImapRfc822MessageBody,
} from "../../src/service/imap-mime-parser.js";
import { ImapFlowTransport } from "../../src/service/imap-transport.js";
import { startStatefulLoopbackTlsImapServer } from "../helpers/stateful-loopback-tls-imap-server.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(currentDir, "../../../../apps/desktop/scripts/fixtures");

interface CertModule {
  generateEphemeralLoopbackTlsCertificate(): { certPem: string; keyPem: string };
}

describe("IMAP folder classifier and RFC 5322 MIME parser", () => {
  it("classifies RFC 6154 special-use flags and localized folder names", () => {
    expect(classifyImapFolderKind("INBOX")).toBe("inbox");
    expect(classifyImapFolderKind("All Mail", "\\Archive")).toBe("archive");
    expect(classifyImapFolderKind("Junk Mail", undefined, ["\\Junk"])).toBe("spam");
    expect(classifyImapFolderKind("已归档")).toBe("archive");
    expect(classifyImapFolderKind("垃圾邮件")).toBe("spam");
    expect(classifyImapFolderKind("已删除邮件")).toBe("trash");
    expect(classifyImapFolderKind("已发送")).toBe("sent");
    expect(classifyImapFolderKind("草稿箱")).toBe("drafts");
    expect(classifyImapFolderKind("Projects/2026")).toBe("mail");
  });

  it("parses encoded RFC 2047 headers, duplicate headers, quoted-printable UTF-8, base64 HTML, and attachments", () => {
    const encodedSubject = `=?UTF-8?B?${Buffer.from("验证码 884422", "utf8").toString("base64")}?=`;
    const htmlBase64 = Buffer.from("<div>Hello <b>EasyEmail</b> — code 884422</div>", "utf8").toString("base64");
    const rawRfc822 = [
      `Subject: ${encodedSubject}`,
      "From: =?UTF-8?B?5Y+R5Lu25Lq6?= <notify@example.com>",
      "Message-ID: <mime-1@example.com>",
      "References: <root-1@example.com>",
      "References: <root-2@example.com> <root-1@example.com>",
      "List-Unsubscribe: <mailto:unsub@example.com>",
      'Content-Type: multipart/mixed; boundary="mix-boundary"',
      "",
      "--mix-boundary",
      'Content-Type: multipart/alternative; boundary="alt-boundary"',
      "",
      "--alt-boundary",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Hello =E4=B8=96=E7=95=8C =E2=80=94 code 884422",
      "--alt-boundary",
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      htmlBase64,
      "--alt-boundary--",
      "--mix-boundary",
      'Content-Type: application/pdf; name="statement.pdf"',
      'Content-Disposition: attachment; filename="statement.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("PDFDATA").toString("base64"),
      "--mix-boundary--",
      "",
    ].join("\r\n");

    const headers = extractStructuredMimeHeaders(rawRfc822);
    expect(headers.subject).toBe("验证码 884422");
    expect(headers.messageId).toBe("<mime-1@example.com>");
    expect(headers.references).toEqual(["<root-1@example.com>", "<root-2@example.com>"]);
    expect(headers.listUnsubscribe).toContain("unsub@example.com");

    const parsed = parseImapRfc822MessageBody(rawRfc822);
    expect(parsed.bodyText).toContain("Hello 世界 — code 884422");
    expect(parsed.bodyHtml).toContain("<b>EasyEmail</b>");
    expect(parsed.hasAttachments).toBe(true);
  });
});

describe("ImapFlowTransport over stateful loopback TLS 1.2+", () => {
  it("discovers folders, performs initial and incremental UID sync, fetches bodies, mutates flags, and moves messages", async () => {
    const { generateEphemeralLoopbackTlsCertificate } = (await import(
      pathToFileURL(resolve(fixturesDir, "ephemeral-loopback-tls-cert.mjs")).href
    )) as CertModule;
    const { certPem, keyPem } = generateEphemeralLoopbackTlsCertificate();
    const canarySecret = "imap-sync-canary-secret-7741";

    const server = await startStatefulLoopbackTlsImapServer({
      certPem,
      keyPem,
      expectedUsername: "reader@example.com",
      expectedPassword: canarySecret,
    });

    try {
      server.appendMessage("INBOX", {
        uid: 10,
        flags: [],
        subject: "Welcome 10",
        fromName: "Team",
        fromAddress: "team@example.com",
        messageId: "<msg-10@example.com>",
        rawRfc822: [
          "Subject: Welcome 10",
          "From: Team <team@example.com>",
          "Message-ID: <msg-10@example.com>",
          'Content-Type: text/plain; charset="utf-8"',
          "",
          "First message body content.",
        ].join("\r\n"),
      });
      server.appendMessage("INBOX", {
        uid: 12,
        flags: ["\\Seen"],
        subject: "Security Code 592014",
        fromName: "Auth",
        fromAddress: "auth@example.com",
        messageId: "<msg-12@example.com>",
        hasAttachment: true,
        rawRfc822: [
          "Subject: Security Code 592014",
          "From: Auth <auth@example.com>",
          "Message-ID: <msg-12@example.com>",
          'Content-Type: text/html; charset="utf-8"',
          "",
          "<p>Your code is <strong>592014</strong></p>",
        ].join("\r\n"),
      });

      const profile = {
        protocol: "imap" as const,
        host: "127.0.0.1",
        port: server.port,
        security: "tls" as const,
        username: "reader@example.com",
      };
      const transport = new ImapFlowTransport({
        connectionTimeoutMs: 5_000,
        ca: certPem,
      });

      const folders = await transport.discoverFolders(profile, canarySecret);
      expect(folders.map((item) => ({ path: item.path, kind: item.folderKind }))).toEqual([
        { path: "INBOX", kind: "inbox" },
        { path: "Archive", kind: "archive" },
        { path: "Spam", kind: "spam" },
        { path: "Trash", kind: "trash" },
      ]);

      const initialBatch = await transport.syncFolderHeaders(profile, canarySecret, {
        folderPath: "INBOX",
        limit: 25,
      });
      expect(initialBatch.uidValidity).toBe("100");
      expect(initialBatch.uidValidityChanged).toBe(false);
      expect(initialBatch.highestSeenUid).toBe("12");
      expect(initialBatch.headers.map((h) => h.uid)).toEqual(["12", "10"]);
      expect(initialBatch.headers[0]).toMatchObject({
        uid: "12",
        isRead: true,
        hasAttachments: true,
        rfcMessageId: "<msg-12@example.com>",
      });

      // No new messages -> incremental sync returns empty without error
      const emptyIncremental = await transport.syncFolderHeaders(profile, canarySecret, {
        folderPath: "INBOX",
        knownUidValidity: "100",
        lastSeenUid: "12",
        limit: 25,
      });
      expect(emptyIncremental.headers).toEqual([]);

      // Append UID 15 -> incremental sync fetches only UID 15
      server.appendMessage("INBOX", {
        uid: 15,
        flags: [],
        subject: "Incremental 15",
        fromAddress: "news@example.com",
        messageId: "<msg-15@example.com>",
        rawRfc822: "Subject: Incremental 15\r\nFrom: news@example.com\r\nList-Unsubscribe: <mailto:u@example.com>\r\n\r\nBody 15",
      });
      const incrementalBatch = await transport.syncFolderHeaders(profile, canarySecret, {
        folderPath: "INBOX",
        knownUidValidity: "100",
        lastSeenUid: "12",
        limit: 25,
      });
      expect(incrementalBatch.headers.map((h) => h.uid)).toEqual(["15"]);
      expect(incrementalBatch.headers[0]?.isNewsletter).toBe(true);

      // Lazy body fetch
      const hydrated = await transport.fetchMessageBody(profile, canarySecret, "INBOX", "12");
      expect(hydrated?.bodyHtml).toContain("592014");

      // Flag toggle
      await transport.setMessageFlag(profile, canarySecret, "INBOX", "10", "\\Flagged", true);
      expect(server.getFolder("INBOX")?.messages.find((m) => m.uid === 10)?.flags).toContain("\\Flagged");
      await transport.setMessageFlag(profile, canarySecret, "INBOX", "10", "\\Flagged", false);
      expect(server.getFolder("INBOX")?.messages.find((m) => m.uid === 10)?.flags).not.toContain("\\Flagged");

      // UID MOVE to Archive
      const moved = await transport.moveMessage(profile, canarySecret, "INBOX", "10", "Archive");
      expect(moved).toEqual({ targetUid: "1", targetUidValidity: "200" });
      expect(server.getFolder("INBOX")?.messages.map((m) => m.uid)).toEqual([12, 15]);
      expect(server.getFolder("Archive")?.messages.map((m) => m.uid)).toEqual([1]);

      // Permanent delete (\Deleted + EXPUNGE)
      await transport.setMessageFlag(profile, canarySecret, "INBOX", "15", "\\Deleted", true);
      expect(server.getFolder("INBOX")?.messages.map((m) => m.uid)).toEqual([12]);

      // Wrong password fails closed without leaking secret
      const wrongSecret = "wrong-imap-secret-9999";
      const badPromise = transport.discoverFolders(profile, wrongSecret);
      await expect(badPromise).rejects.toMatchObject({ code: "IMAP_AUTH_FAILED" });
      await expect(badPromise).rejects.not.toThrow(wrongSecret);
    } finally {
      await server.close();
    }
  });

  it("falls back cleanly to UID COPY + EXPUNGE when server omits MOVE capability", async () => {
    const { generateEphemeralLoopbackTlsCertificate } = (await import(
      pathToFileURL(resolve(fixturesDir, "ephemeral-loopback-tls-cert.mjs")).href
    )) as CertModule;
    const { certPem, keyPem } = generateEphemeralLoopbackTlsCertificate();
    const secret = "copy-fallback-secret";
    const server = await startStatefulLoopbackTlsImapServer({
      certPem,
      keyPem,
      expectedUsername: "copy@example.com",
      expectedPassword: secret,
      enableMoveCapability: false,
    });

    try {
      server.appendMessage("INBOX", {
        uid: 5,
        flags: [],
        subject: "Copy Fallback",
        fromAddress: "a@example.com",
        rawRfc822: "Subject: Copy Fallback\r\nFrom: a@example.com\r\n\r\nCopy text",
      });
      const transport = new ImapFlowTransport({ connectionTimeoutMs: 5_000, ca: certPem });
      const profile = {
        protocol: "imap" as const,
        host: "127.0.0.1",
        port: server.port,
        security: "tls" as const,
        username: "copy@example.com",
      };
      const result = await transport.moveMessage(profile, secret, "INBOX", "5", "Trash");
      expect(result.targetUid).toBe("1");
      expect(server.getFolder("INBOX")?.messages).toHaveLength(0);
      expect(server.getFolder("Trash")?.messages).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import PostalMime from "postal-mime";
const compiled = await build({ entryPoints: [fileURLToPath(new URL("../src/smtp-mime.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "node" });
const { smtpMime } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`);
const input = { from: "from@example.test", to: "to@example.test", cc: ["cc@example.test"], bcc: ["hidden@example.test"], subject: "Subject", text: "text\n.", id: "fixed-id", createdAt: 0 };
test("SMTP no-attachment MIME is byte-for-byte stable, including empty refs and threading", () => {
  const expected = ["From: <from@example.test>", "To: <to@example.test>", "Cc: <cc@example.test>", "Subject: =?UTF-8?B?U3ViamVjdA==?=",
    "Date: Thu, 01 Jan 1970 00:00:00 GMT", "Message-ID: <fixed-id@easyemail.invalid>", "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", "dGV4dA0KLg==", ".", ""].join("\r\n");
  assert.equal(smtpMime(input), expected); assert.equal(smtpMime({ ...input, attachments: [] }), expected);
  const threaded = smtpMime({ ...input, threading: { inReplyTo: "<parent@test>", references: ["<root@test>", "<parent@test>"] } });
  assert.equal(threaded, expected.replace("Subject:", "In-Reply-To: <parent@test>\r\nReferences: <root@test>\r\n <parent@test>\r\nSubject:"));
});
test("SMTP multipart preserves five binary files and long RFC2231 Unicode names within line limits", async () => {
  const bytes = Buffer.from([0, 255, 128, 13, 10, 46, 0]), names = ["文档;百分比%😀.bin", "😀".repeat(120), "a=b;test.bin", "report's(1).bin", "plain.bin"];
  const mime = smtpMime({ ...input, attachments: names.map(filename => ({ filename, type: "application/octet-stream", content: bytes.toString("base64") })),
    threading: { inReplyTo: "<parent@test>", references: ["<root@test>", "<parent@test>"] } });
  assert.doesNotMatch(mime, /Bcc:|hidden@example/); assert.ok(mime.split("\r\n").every(line => Buffer.byteLength(line) <= 998));
  assert.equal(mime.match(/\r\n\.\r\n/g).length, 1); assert.equal(mime.match(/--easyemail-fixed-id--/g).length, 1);
  const parsed = await PostalMime.parse(mime.replace(/\r\n\.\r\n$/, "\r\n"));
  assert.equal(parsed.inReplyTo, "<parent@test>"); assert.equal(parsed.attachments.length, 5);
  for (const [index, attachment] of parsed.attachments.entries()) { assert.equal(attachment.filename, names[index]); assert.deepEqual(Buffer.from(attachment.content), bytes); }
});
test("SMTP final serialized size is bounded before reservation", () => {
  assert.throws(() => smtpMime({ ...input, attachments: [{ filename: "big.bin", type: "application/octet-stream", content: "a".repeat(5 * 1024 * 1024) }] }), error => error.status === 413);
});

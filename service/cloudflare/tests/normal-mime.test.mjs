import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { ATTACHMENT, mimeMessage, multipartMessage, nestedMimeMessage } from "./normal-mime-fixture.mjs";

let parse;
const address = "alice@example.test", receivedAt = 1793232000;
const sha256 = value => createHash("sha256").update(value).digest("hex");
before(async () => {
  assert.ok(process.env.EASYEMAIL_TEST_ROOT);
  await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "mime-")), outfile = path.join(directory, "mime.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/normal-mime-content.ts", import.meta.url))], outfile, bundle: true, format: "esm", platform: "node" });
  parse = (await import(pathToFileURL(outfile))).parseNormalMime;
});
test("MIME mapping decodes Unicode and binds recipient/time to the authenticated account and INTERNALDATE", async () => {
  const raw = mimeMessage("Date: Fri, 01 Jan 1999 00:00:00 +0000\r\n"), result = await parse(raw, address, receivedAt);
  assert.equal(result.content.sender, "发件人 <sender@example.test>");
  assert.equal(result.content.subject, "验证码"); assert.equal(result.content.textBody, "验证码 742951\n");
  assert.equal(result.content.recipient, address); assert.equal(result.content.receivedAt, receivedAt);
  assert.equal(result.content.rfcMessageId, "<imap-test@example.test>"); assert.equal(result.rawSha256, sha256(raw));
  assert.equal("remoteId" in result.content, false, "RFC Message-ID is not an IMAP storage identity");
});
test("MIME attachment metadata hashes decoded binary bytes, preserving original part index", async () => {
  const result = await parse(multipartMessage(), address, receivedAt), part = result.content.attachments[0];
  assert.equal(result.content.attachments.length, 1); assert.equal(part.index, 0);
  assert.equal(part.filename, "part-0.bin"); assert.equal(part.mimeType, "application/octet-stream");
  assert.equal(part.size, ATTACHMENT.length); assert.equal(part.sha256, sha256(ATTACHMENT));
  assert.match(result.content.textBody, /纯文本/); assert.match(result.content.htmlBody, /<script>/);
  assert.equal("downloadable" in part, false, "Parsing alone must not imply attachment retrieval is wired");
});
test("MIME metadata caps 100 attachments and explicitly reports the omitted part", async () => {
  const result = await parse(multipartMessage(101), address, receivedAt);
  assert.equal(result.content.attachments.length, 100); assert.equal(result.content.attachmentsTruncated, true);
  assert.deepEqual(result.content.attachments.map(part => part.index), Array.from({ length: 100 }, (_, i) => i));
});
test("MIME content limits stay compatible with the shared cache contract", async () => {
  const raw = new TextEncoder().encode(`From: ${"n".repeat(2200)} <sender@example.test>\r\nSubject: ${"s".repeat(5000)}\r\nContent-Type: text/plain\r\n\r\n${"b".repeat(150000)}`);
  const result = await parse(raw, address, receivedAt);
  assert.equal(result.content.sender.length, 2048); assert.equal(result.content.subject.length, 4096);
  assert.equal(result.content.textBody.length, 131072); assert.equal(result.content.attachmentsTruncated, false);
});
test("thread and list headers use only the allowlist and existing normalization rules", async () => {
  const result = await parse(mimeMessage("In-Reply-To: <Parent@EXAMPLE.TEST>\r\nReferences: <root@example.test>\r\n\t<Parent@EXAMPLE.TEST>\r\nList-ID: News <news.example.test>\r\nList-Unsubscribe: <https://example.test/u>\r\nX-Secret: private-header\r\n"), address, receivedAt);
  assert.deepEqual(result.content.threadHeaders.inReplyTo, ["<Parent@example.test>"]);
  assert.deepEqual(result.content.threadHeaders.references, ["<root@example.test>", "<Parent@example.test>"]);
  assert.equal(result.content.subscriptionHeaders.listId, "News <news.example.test>");
  assert.equal(JSON.stringify(result).includes("private-header"), false);
});
test("duplicate/invalid RFC Message-ID is not accepted as a stable message identity", async () => {
  for (const header of ["Message-ID: <second@example.test>\r\n", "Message-ID: invalid\r\n"]) {
    const result = await parse(mimeMessage(header), address, receivedAt);
    assert.equal(result.content.rfcMessageId, null);
  }
  const same = mimeMessage(); assert.deepEqual(await parse(same, address, receivedAt), await parse(same, address, receivedAt));
});
test("MIME limits reject oversized raw input and parser resource exhaustion with sanitized errors", async () => {
  await assert.rejects(parse(new Uint8Array(2 * 1024 * 1024 + 1), address, receivedAt), error => error.code === "normal_message_too_large");
  await assert.rejects(parse(nestedMimeMessage(36), address, receivedAt), error => error.code === "normal_mime_parse_failed" && !error.message.includes("private"));
  const headers = new TextEncoder().encode(`X-Large: ${"h".repeat(256 * 1024)}\r\n\r\nprivate-body`);
  await assert.rejects(parse(headers, address, receivedAt), error => error.code === "normal_mime_parse_failed");
  await assert.rejects(parse(multipartMessage(201), address, receivedAt), error => error.code === "normal_mime_parse_failed");
});
test("historical INTERNALDATE remains deterministic before the Unix epoch", async () => {
  const result = await parse(mimeMessage(), address, -1); assert.equal(result.content.receivedAt, -1);
});
test("MIME mapper requires a known recipient, nonempty raw bytes and stable INTERNALDATE", async () => {
  for (const args of [[mimeMessage(), address, NaN], [mimeMessage(), address, null], [new Uint8Array(), address, receivedAt], [mimeMessage(), "not-an-address", receivedAt]]) {
    await assert.rejects(parse(...args), error => error.code === "invalid_normal_message");
  }
});

test("Agent reply evidence rejects ambiguous mailbox authors without changing normal MIME content or hashes", async () => {
  for (const from of ["agent@example.test, other@example.test", "Group: agent@example.test;", "Group: agent@example.test;, other@example.test", "not-an-address"]) {
    const raw = new TextEncoder().encode(`From: ${from}\r\nIn-Reply-To: <task@example.test>\r\n\r\nbody`);
    const normal = await parse(raw, address, receivedAt), agent = await parse(raw, address, receivedAt, true);
    assert.equal(agent.replyEvidence.from, null, from); assert.deepEqual(agent.content, normal.content); assert.equal(agent.rawSha256, normal.rawSha256);
    assert.equal("replyEvidence" in normal, false);
  }
  const raw = new TextEncoder().encode('From: "Agent, Remote" <Agent@EXAMPLE.TEST>\r\n\r\nbody');
  assert.equal((await parse(raw, address, receivedAt, true)).replyEvidence.from, "agent@example.test");
});

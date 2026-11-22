import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function moduleAt(relative) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true,
    write: false, format: "esm", platform: "browser", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
}

test("download metadata is independently bounded and filenames cannot inject headers, paths or invalid UTF-16", async () => {
  const { downloadable, attachmentFilename, attachmentDisposition } = await moduleAt("../src/attachment-policy.ts");
  const item = { index: 0, sha256: "ab".repeat(32), size: 0 };
  assert.equal(downloadable(item), true);
  for (const changed of [{ index: -1 }, { index: 100 }, { index: 0.5 }, { sha256: "AA".repeat(32) },
    { sha256: "ab" }, { sha256: undefined }, { size: -1 }, { size: 5 * 1024 * 1024 + 1 }, { size: Infinity }]) {
    assert.equal(downloadable({ ...item, ...changed }), false, JSON.stringify(changed));
  }
  for (const value of ["../../evil.exe\r\nX-Header: attack", "CON.txt", "nul", "..", "", "a\u202eexe.txt",
    "\ud800", "x".repeat(119) + "😀", "x".repeat(119) + "\udc00", "报告.txt"]) {
    const filename = attachmentFilename(value);
    assert.ok(filename.length > 0 && Array.from(filename).length <= 131);
    assert.doesNotMatch(filename, /[\p{Cc}\p{Cf}<>:"/\\|?*]/u);
    assert.doesNotMatch(filename, /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i);
    assert.doesNotThrow(() => attachmentDisposition(value));
    assert.doesNotMatch(attachmentDisposition(value), /[\r\n]/);
  }
  assert.equal(attachmentFilename("报告.txt"), "报告.txt");
});

test("self-hosted parsed metadata adds exact decoded-byte digests while retaining the legacy list and fields", async () => {
  const { parsedAttachmentMetadata } = await moduleAt("../../../upstreams/cloudflare_temp_email/worker/src/mails_api/parsed_attachment_metadata.ts");
  const attachments = Array.from({ length: 102 }, (_, index) => ({ filename: `文件-${index}.bin`,
    mimeType: "application/octet-stream", disposition: "attachment", content: new Uint8Array([0, 255, index]) }));
  const result = await parsedAttachmentMetadata(attachments);
  assert.equal(result.length, attachments.length);
  for (const [index, item] of result.entries()) {
    const { content, ...legacy } = attachments[index];
    assert.deepEqual({ filename: item.filename, mimeType: item.mimeType, disposition: item.disposition, size: item.size },
      { ...legacy, size: content.length });
    assert.equal(item.index, index);
    assert.equal(item.sha256, index < 100 ? createHash("sha256").update(content).digest("hex") : undefined);
  }
  const empty = await parsedAttachmentMetadata([{ ...attachments[0], content: new Uint8Array() }]);
  assert.equal(empty[0].sha256, createHash("sha256").update("").digest("hex"));
  assert.deepEqual(await parsedAttachmentMetadata([]), []);
});

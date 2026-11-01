import { createHash } from "node:crypto";
import { cfMail } from "./provider-fixture.mjs";

export const bytesHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function attachmentMail(address, bytes = Buffer.from("合成附件\0binary\xff", "utf8"), filename = "报告.txt") {
  const mail = cfMail(address, 71, "Attachment body");
  const attachment = { filename, mimeType: "application/octet-stream", size: bytes.length, index: 0, sha256: bytesHash(bytes) };
  const raw = ["From: noreply@example.test", `To: ${address}`, "Subject: Verify your account", "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="test-boundary"', "", "--test-boundary", "Content-Type: text/plain; charset=utf-8", "", mail.text,
    "--test-boundary", "Content-Type: application/octet-stream", `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Content-Transfer-Encoding: base64", "", bytes.toString("base64"), "--test-boundary--", ""].join("\r\n");
  return { parsed: { ...mail, attachments: [attachment] }, raw: { id: mail.id, address, raw }, bytes };
}

export const downloadPath = (box, message, index = 0) => `/api/v1/mailboxes/${box.id}/messages/${message.id}/attachments/${index}`;
export async function binaryRequest(h, path, cookie, extra = {}) {
  const response = await fetch(new URL(path, h.baseUrl), { headers: { cookie, connection: "close", ...extra }, redirect: "manual" });
  return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
}

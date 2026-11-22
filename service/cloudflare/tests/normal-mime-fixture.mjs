export const ATTACHMENT = new Uint8Array([0, 255, 128, 65, 13, 10]);
const encode = text => new TextEncoder().encode(text);
export function mimeMessage(extra = "", body = "验证码 742951") {
  return encode(`From: =?UTF-8?B?5Y+R5Lu25Lq6?= <sender@example.test>\r\nTo: unrelated@example.test\r\nSubject: =?UTF-8?B?6aqM6K+B56CB?=\r\nMessage-ID: <imap-test@example.test>\r\n${extra}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
}
export function multipartMessage(count = 1) {
  const headers = "From: sender@example.test\r\nSubject: attachments\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=parts\r\n\r\n";
  const text = "--parts\r\nContent-Type: multipart/alternative; boundary=alt\r\n\r\n--alt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n纯文本\r\n--alt\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>HTML</p><script>not-safe</script>\r\n--alt--\r\n";
  const attachment = index => `--parts\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="part-${index}.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(ATTACHMENT).toString("base64")}\r\n`;
  return encode(headers + text + Array.from({ length: count }, (_, index) => attachment(index)).join("") + "--parts--\r\n");
}
export function nestedMimeMessage(depth) {
  const prefix = Array.from({ length: depth }, (_, i) => `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n`).join("");
  const suffix = Array.from({ length: depth }, (_, i) => `\r\n--b${depth - i - 1}--\r\n`).join("");
  return encode(prefix + "Content-Type: text/plain\r\n\r\nprivate-body-must-not-leak" + suffix);
}

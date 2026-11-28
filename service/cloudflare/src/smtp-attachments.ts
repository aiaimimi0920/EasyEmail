export interface SmtpAttachment { filename: string; type: string; content: string; contentId?: string }

function filenameParameters(filename: string) {
  // RFC 2231 continuations keep even 120 four-byte characters below SMTP line limits.
  // Split at code-point boundaries, never inside a percent escape or UTF-8 sequence.
  const chunks: string[] = []; let chunk = "";
  for (const character of filename) {
    const encoded = encodeURIComponent(character).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
    if (chunk.length + encoded.length > 48) { chunks.push(chunk); chunk = ""; }
    chunk += encoded;
  }
  chunks.push(chunk);
  return chunks.map((value, index) => ` filename*${index}*=${index === 0 ? "UTF-8''" : ""}${value}`).join(";\r\n");
}

export function smtpMultipart(boundary: string, text: string, attachments: SmtpAttachment[], htmlBase64?: string) {
  const hasInlineCid = attachments.some((item) => !!item.contentId);
  const topSubtype = attachments.length > 0 ? (hasInlineCid && htmlBase64 ? "related" : "mixed") : "alternative";
  const parts: string[] = [`Content-Type: multipart/${topSubtype}; boundary="${boundary}"`, ""];

  if (htmlBase64 && attachments.length > 0) {
    const altBoundary = `${boundary}-alt`;
    parts.push(
      `--${boundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      `--${altBoundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      text,
      `--${altBoundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      htmlBase64,
      `--${altBoundary}--`,
    );
  } else {
    parts.push(`--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", text);
    if (htmlBase64) {
      parts.push(`--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", htmlBase64);
    }
  }

  for (const attachment of attachments) {
    const cleanCid = attachment.contentId?.replace(/[<>\r\n\s]/g, "");
    const disposition = cleanCid ? "inline;" : "attachment;";
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.type}`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: ${disposition}`,
      filenameParameters(attachment.filename),
      ...(cleanCid ? [`Content-ID: <${cleanCid}>`] : []),
      "",
      attachment.content.match(/.{1,76}/g)?.join("\r\n") ?? "",
    );
  }
  parts.push(`--${boundary}--`);
  return parts;
}

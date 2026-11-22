import { randomUUID } from "node:crypto";

import { EasyEmailError } from "../domain/errors.js";
import type { MailSmtpSendEnvelope } from "./account-connectivity.js";

const CONTROL_OR_CRLF_RE = /[\r\n\u0000-\u001f\u007f]/u;
const NON_ASCII_RE = /[^\x20-\x7e]/u;

export function extractEnvelopeEmailAddress(rawValue: string, fieldName: string): string {
  if (CONTROL_OR_CRLF_RE.test(rawValue)) {
    throw new EasyEmailError("INVALID_SEND_MESSAGE", `${fieldName} contains control characters.`);
  }
  const trimmed = rawValue.trim();
  const angleStart = trimmed.indexOf("<");
  const angleEnd = angleStart >= 0 ? trimmed.indexOf(">", angleStart + 1) : -1;
  const candidate = angleStart >= 0 && angleEnd > angleStart
    ? trimmed.slice(angleStart + 1, angleEnd).trim()
    : trimmed;
  if (
    !candidate
    || candidate.length > 320
    || /[\s<>]/u.test(candidate)
    || !candidate.includes("@")
    || candidate.startsWith("@")
    || candidate.endsWith("@")
  ) {
    throw new EasyEmailError("INVALID_SEND_MESSAGE", `${fieldName} is not a valid email address.`);
  }
  const atIndex = candidate.lastIndexOf("@");
  const localPart = candidate.slice(0, atIndex);
  const domainPart = candidate.slice(atIndex + 1).toLowerCase();
  if (!localPart || !domainPart || !domainPart.includes(".")) {
    throw new EasyEmailError("INVALID_SEND_MESSAGE", `${fieldName} is not a valid email address.`);
  }
  return `${localPart}@${domainPart}`;
}

export function encodeRfc2047HeaderText(rawText: string): string {
  const sanitized = rawText.replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ").trim();
  if (!sanitized) return "";
  if (!NON_ASCII_RE.test(sanitized) && !sanitized.includes("=?")) {
    return sanitized;
  }
  const chunks: string[] = [];
  let current = "";
  for (const char of Array.from(sanitized)) {
    const next = current + char;
    if (Buffer.byteLength(next, "utf8") > 36 && current.length > 0) {
      chunks.push(`=?UTF-8?B?${Buffer.from(current, "utf8").toString("base64")}?=`);
      current = char;
    } else {
      current = next;
    }
  }
  if (current.length > 0) {
    chunks.push(`=?UTF-8?B?${Buffer.from(current, "utf8").toString("base64")}?=`);
  }
  return chunks.join("\r\n ");
}

function formatAddressHeaderValue(address: string, displayName?: string): string {
  const bare = extractEnvelopeEmailAddress(address, "address");
  const trimmedName = displayName?.replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ").trim();
  if (!trimmedName) {
    return `<${bare}>`;
  }
  if (NON_ASCII_RE.test(trimmedName) || trimmedName.includes("=?")) {
    return `${encodeRfc2047HeaderText(trimmedName)} <${bare}>`;
  }
  const escaped = trimmedName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}" <${bare}>`;
}

function encodeBase64Body(content: string): string {
  const normalized = content.replace(/\r?\n/g, "\r\n");
  const encoded = Buffer.from(normalized, "utf8").toString("base64");
  if (!encoded) return "";
  const lines: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += 76) {
    lines.push(encoded.slice(offset, offset + 76));
  }
  return lines.join("\r\n");
}

export function dotStuffSmtpMessage(rawMessage: string): string {
  const normalized = rawMessage.replace(/\r?\n/g, "\r\n");
  return normalized
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

export function buildSmtpMimeSubmission(
  envelope: MailSmtpSendEnvelope,
  now: Date = new Date(),
): {
  mailFrom: string;
  rcptTo: string[];
  dotStuffedData: string;
  rfcMessageId: string;
} {
  const mailFrom = extractEnvelopeEmailAddress(envelope.fromAddress, "fromAddress");
  const toList = envelope.toAddresses.map((addr) => extractEnvelopeEmailAddress(addr, "toAddress"));
  const ccList = envelope.ccAddresses.map((addr) => extractEnvelopeEmailAddress(addr, "ccAddress"));
  const bccList = envelope.bccAddresses.map((addr) => extractEnvelopeEmailAddress(addr, "bccAddress"));
  if (toList.length === 0) {
    throw new EasyEmailError("INVALID_SEND_MESSAGE", "At least one recipient address is required.");
  }
  const rcptTo = Array.from(new Set([...toList, ...ccList, ...bccList]));
  const senderDomain = mailFrom.slice(mailFrom.lastIndexOf("@") + 1) || "easyemail.local";
  const rfcMessageId = envelope.rfcMessageId?.trim() || `<${randomUUID()}@${senderDomain}>`;
  const headers: string[] = [
    `Date: ${now.toUTCString()}`,
    `Message-ID: ${rfcMessageId}`,
    `From: ${formatAddressHeaderValue(mailFrom, envelope.fromName)}`,
    `To: ${toList.map((addr) => `<${addr}>`).join(", ")}`,
  ];
  if (ccList.length > 0) {
    headers.push(`Cc: ${ccList.map((addr) => `<${addr}>`).join(", ")}`);
  }
  headers.push(`Subject: ${encodeRfc2047HeaderText(envelope.subject)}`);
  headers.push("MIME-Version: 1.0");

  let bodySection: string;
  if (envelope.bodyHtml && envelope.bodyHtml.trim().length > 0) {
    const boundary = `=_easyemail_${randomUUID().replaceAll("-", "")}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    bodySection = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      encodeBase64Body(envelope.bodyText),
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      encodeBase64Body(envelope.bodyHtml),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8");
    headers.push("Content-Transfer-Encoding: base64");
    bodySection = `${encodeBase64Body(envelope.bodyText)}\r\n`;
  }

  const rawMessage = `${headers.join("\r\n")}\r\n\r\n${bodySection}`;
  return {
    mailFrom,
    rcptTo,
    dotStuffedData: dotStuffSmtpMessage(rawMessage),
    rfcMessageId,
  };
}

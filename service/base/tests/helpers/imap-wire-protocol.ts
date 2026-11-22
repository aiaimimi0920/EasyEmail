export interface FakeImapStoredMessage {
  uid: number;
  flags: string[];
  internalDate?: string;
  subject: string;
  fromName?: string;
  fromAddress: string;
  messageId?: string;
  inReplyTo?: string;
  rawHeaders?: string;
  rawRfc822: string;
  hasAttachment?: boolean;
}

export interface FakeImapFolderState {
  path: string;
  delimiter?: string;
  flags?: string[];
  uidValidity: number;
  uidNext: number;
  messages: FakeImapStoredMessage[];
}

function imapLiteralOrNil(value: string | undefined): string {
  if (value === undefined) return "NIL";
  const bytes = Buffer.from(value, "utf8");
  return `{${bytes.length}}\r\n${value}`;
}

export function parseImapTokens(input: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < input.length) {
    while (index < input.length && input[index] === " ") index += 1;
    if (index >= input.length) break;
    if (input[index] === '"') {
      index += 1;
      let value = "";
      while (index < input.length && input[index] !== '"') {
        if (input[index] === "\\" && index + 1 < input.length) index += 1;
        value += input[index] ?? "";
        index += 1;
      }
      index += 1;
      tokens.push(value);
    } else if (input[index] === "(") {
      let depth = 0;
      const start = index;
      while (index < input.length) {
        if (input[index] === "(") depth += 1;
        else if (input[index] === ")") {
          depth -= 1;
          if (depth === 0) {
            index += 1;
            break;
          }
        }
        index += 1;
      }
      tokens.push(input.slice(start, index));
    } else {
      let end = index;
      while (end < input.length && input[end] !== " ") end += 1;
      tokens.push(input.slice(index, end));
      index = end;
    }
  }
  return tokens;
}

export function decodePlainSasl(encoded: string): { username: string; password: string } | null {
  try {
    const decoded = Buffer.from(encoded.trim(), "base64").toString("utf8");
    const parts = decoded.split("\u0000");
    if (parts.length < 3) return null;
    return {
      username: parts[1] ?? "",
      password: parts.slice(2).join("\u0000"),
    };
  } catch {
    return null;
  }
}

export function matchesImapSequenceSet(
  sequenceSet: string,
  value: number,
  maxValue: number,
): boolean {
  for (const part of sequenceSet.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (!trimmed.includes(":")) {
      const target = trimmed === "*" ? maxValue : Number(trimmed);
      if (value === target) return true;
      continue;
    }
    const [rawStart, rawEnd] = trimmed.split(":");
    const start = rawStart === "*" ? maxValue : Number(rawStart);
    const end = rawEnd === "*" ? maxValue : Number(rawEnd);
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    if (value >= low && value <= high) return true;
  }
  return false;
}

function buildEnvelope(msg: FakeImapStoredMessage): string {
  const atIndex = msg.fromAddress.indexOf("@");
  const mailbox = atIndex >= 0 ? msg.fromAddress.slice(0, atIndex) : msg.fromAddress;
  const host = atIndex >= 0 ? msg.fromAddress.slice(atIndex + 1) : "localhost";
  const dateStr = msg.internalDate ?? "22-Sep-2026 08:30:00 +0000";
  return [
    "(",
    imapLiteralOrNil(dateStr),
    " ",
    imapLiteralOrNil(msg.subject),
    " ((",
    imapLiteralOrNil(msg.fromName),
    " NIL ",
    imapLiteralOrNil(mailbox),
    " ",
    imapLiteralOrNil(host),
    ")) NIL NIL NIL NIL NIL ",
    imapLiteralOrNil(msg.inReplyTo),
    " ",
    imapLiteralOrNil(msg.messageId),
    ")",
  ].join("");
}

function buildBodyStructure(msg: FakeImapStoredMessage): string {
  if (msg.hasAttachment) {
    return '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 42 2 NIL NIL NIL NIL)("APPLICATION" "PDF" ("NAME" "doc.pdf") NIL NIL "BASE64" 128 NIL ("ATTACHMENT" ("FILENAME" "doc.pdf")) NIL NIL) "MIXED" ("BOUNDARY" "b1") NIL NIL NIL)';
  }
  return '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 42 2 NIL NIL NIL NIL)';
}

function buildHeaderSection(msg: FakeImapStoredMessage): string {
  if (msg.rawHeaders) {
    return msg.rawHeaders.endsWith("\r\n\r\n")
      ? msg.rawHeaders
      : `${msg.rawHeaders.replace(/\r?\n$/u, "")}\r\n\r\n`;
  }
  const splitIdx = msg.rawRfc822.indexOf("\r\n\r\n");
  if (splitIdx >= 0) {
    return msg.rawRfc822.slice(0, splitIdx + 4);
  }
  return `Subject: ${msg.subject}\r\nFrom: ${msg.fromAddress}\r\n\r\n`;
}

export function formatFetchItem(seq: number, msg: FakeImapStoredMessage, rawSpec: string): string {
  const upperSpec = rawSpec.toUpperCase();
  const parts: string[] = [`UID ${msg.uid}`];
  if (upperSpec.includes("FLAGS")) {
    parts.push(`FLAGS (${msg.flags.join(" ")})`);
  }
  if (upperSpec.includes("INTERNALDATE")) {
    parts.push(`INTERNALDATE "${msg.internalDate ?? "22-Sep-2026 08:30:00 +0000"}"`);
  }
  if (upperSpec.includes("ENVELOPE")) {
    parts.push(`ENVELOPE ${buildEnvelope(msg)}`);
  }
  if (upperSpec.includes("BODYSTRUCTURE")) {
    parts.push(`BODYSTRUCTURE ${buildBodyStructure(msg)}`);
  }
  const bodySectionMatches = rawSpec.matchAll(/BODY(?:\.PEEK)?\[([^\]]*)\]/giu);
  for (const match of bodySectionMatches) {
    const section = match[1] ?? "";
    if (section.trim() === "") {
      const bytes = Buffer.from(msg.rawRfc822, "utf8");
      parts.push(`BODY[] {${bytes.length}}\r\n${msg.rawRfc822}`);
    } else {
      const headerText = buildHeaderSection(msg);
      const bytes = Buffer.from(headerText, "utf8");
      parts.push(`BODY[${section}] {${bytes.length}}\r\n${headerText}`);
    }
  }
  return `* ${seq} FETCH (${parts.join(" ")})\r\n`;
}

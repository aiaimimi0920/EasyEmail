import { HttpError } from "./http";

type Value = string | { quoted: string } | Uint8Array | Value[];
const invalid = () => new HttpError(502, "imap_protocol_invalid");
export function imapTokens(text: string): Value[] {
  const tokens: Value[] = []; let index = 0;
  while (index < text.length) {
    const char = text[index++];
    if (char === " ") continue;
    if (char === "(" || char === ")") tokens.push(char);
    else if (char === '"') {
      let value = "", ended = false;
      while (index < text.length) {
        const next = text[index++];
        if (next === '"') { ended = true; break; }
        if (next === "\\") { if (!['"', "\\"].includes(text[index] ?? "")) throw invalid(); value += text[index++]; }
        else value += next;
      }
      if (!ended) throw invalid(); tokens.push({ quoted: value });
    } else {
      let value = char;
      while (index < text.length && !/[ ()"]/.test(text[index])) value += text[index++];
      if (!/^[\x21-\x7e]{1,256}$/.test(value)) throw invalid(); tokens.push(value);
    }
    if (tokens.length > 512) throw new HttpError(502, "imap_response_limit");
  }
  return tokens;
}
function values(tokens: Value[]): Value[] {
  let index = 0;
  function list(depth: number): Value[] {
    if (depth > 4 || tokens[index++] !== "(") throw invalid();
    const items: Value[] = [];
    while (index < tokens.length) {
      if (tokens[index] === ")") { index++; return items; }
      items.push(tokens[index] === "(" ? list(depth + 1) : tokens[index++]);
    }
    throw invalid();
  }
  const result = list(0); if (index !== tokens.length) throw invalid(); return result;
}
export function imapNumber(value: unknown, maximum = 4294967295, allowZero = false): number {
  if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) throw invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1) || number > maximum) throw invalid();
  return number;
}
function internalDate(value: Value): number {
  const text = value && typeof value === "object" && "quoted" in value ? value.quoted : "";
  const match = /^( ?\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(text);
  if (!match) throw invalid();
  const day = Number(match[1]), month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(match[2].toLowerCase());
  const year = Number(match[3]), hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  if (year < 1900 || month < 0 || day < 1 || hour > 23 || minute > 59 || second > 59 || Number(match[8]) > 23 || Number(match[9]) > 59) throw invalid();
  const time = Date.UTC(year, month, day, hour, minute, second);
  if (new Date(time).getUTCDate() !== day) throw invalid();
  const offset = (Number(match[8]) * 60 + Number(match[9])) * 60;
  return time / 1000 - (match[7] === "+" ? offset : -offset);
}
export function parseImapFetch(prefix: string, suffix = "", raw?: Uint8Array) {
  const match = /^\* ([1-9]\d{0,9}) FETCH (.*)$/i.exec(prefix); if (!match) throw invalid();
  imapNumber(match[1]);
  const attributes = values([...imapTokens(match[2]), ...(raw === undefined ? [] : [raw]), ...imapTokens(suffix)]);
  const row = new Map<string, Value>();
  if (attributes.length % 2) throw invalid();
  for (let index = 0; index < attributes.length; index += 2) {
    const key = attributes[index]; if (typeof key !== "string") throw invalid();
    const name = key.toUpperCase();
    if (row.has(name) || !["UID", "RFC822.SIZE", "INTERNALDATE", "FLAGS", "BODY[]"].includes(name)) throw invalid();
    row.set(name, attributes[index + 1]);
  }
  const flags = row.get("FLAGS");
  if (!Array.isArray(flags) || flags.length > 100 || flags.some(flag => typeof flag !== "string" || !/^[\x21-\x27\x2b-\x5a\x5c\x5e-\x7e]{1,128}$/.test(flag))) throw invalid();
  if ([...row.keys()].every(key => key === "UID" || key === "FLAGS")) {
    return { kind: "flags" as const, uid: row.has("UID") ? imapNumber(row.get("UID")) : undefined, flags: flags as string[] };
  }
  const body = row.get("BODY[]"); if (body !== undefined && !(body instanceof Uint8Array)) throw invalid();
  return { kind: "message" as const, uid: imapNumber(row.get("UID")), size: imapNumber(row.get("RFC822.SIZE"), Number.MAX_SAFE_INTEGER, true),
    receivedAt: internalDate(row.get("INTERNALDATE")!), flags: flags as string[], raw: body as Uint8Array | undefined };
}

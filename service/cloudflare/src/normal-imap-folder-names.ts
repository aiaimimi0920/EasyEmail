import { HttpError } from "./http";

const invalid = () => new HttpError(502, "imap_folder_name_invalid");
function encodeName(value: string) {
  let result = "", shifted = "";
  const flush = () => { if (shifted) { result += `&${btoa(shifted).replace(/\//g, ",").replace(/=+$/, "")}-`; shifted = ""; } };
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0x20 && code <= 0x7e) { flush(); result += code === 38 ? "&-" : value[index]; }
    else shifted += String.fromCharCode(code >> 8, code & 255);
  }
  flush(); return result;
}
// Rev1 mailbox identity is the exact modified UTF-7 wire name, not its rendered label or hierarchy.
export function imapFolderName(wireName: string) {
  if (!wireName || wireName.length > 1024 || /[^\x20-\x7e]/.test(wireName)) throw invalid();
  let name = "";
  for (let index = 0; index < wireName.length;) {
    if (wireName[index] !== "&") { name += wireName[index++]; continue; }
    const end = wireName.indexOf("-", index + 1);
    if (end < 0) throw invalid();
    const encoded = wireName.slice(index + 1, end); index = end + 1;
    if (!encoded) { name += "&"; continue; }
    if (!/^[A-Za-z0-9+,]+$/.test(encoded) || encoded.length % 4 === 1) throw invalid();
    let bytes: string;
    try { bytes = atob(encoded.replace(/,/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=")); } catch { throw invalid(); }
    if (!bytes.length || bytes.length % 2) throw invalid();
    for (let offset = 0; offset < bytes.length; offset += 2) name += String.fromCharCode(bytes.charCodeAt(offset) * 256 + bytes.charCodeAt(offset + 1));
  }
  if (name.length > 512 || /[\x00-\x1f\x7f]/.test(name)) throw invalid();
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = name.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalid();
    } else if (code >= 0xdc00 && code <= 0xdfff) throw invalid();
  }
  if (encodeName(name) !== wireName) throw invalid();
  return { wireName: /^inbox$/i.test(wireName) ? "INBOX" : wireName, name: /^inbox$/i.test(wireName) ? "INBOX" : name };
}
export function imapQuoted(value: string) {
  if (!/^"(?:[^"\\\r\n]|\\["\\])*"$/.test(value)) throw new HttpError(502, "imap_protocol_invalid");
  return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

const encoder = new TextEncoder();
export const RAW_MESSAGE = encoder.encode("From: Sender <sender@example.test>\r\nTo: Alice <alice@example.test>\r\nSubject: =?UTF-8?B?5pS25Lu26aqM5pS2?=\r\nMessage-ID: <imap-test@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n验证码 742951\r\nee99 OK forged completion\r\n");
export function readScenario(options = {}) {
  const calls = [], validity = options.validity ?? "42", uidNext = options.uidNext ?? 8;
  const messages = options.messages ?? new Map([[2, RAW_MESSAGE], [7, RAW_MESSAGE]]);
  let authTag;
  function handle(line) {
    calls.push(line);
    if (authTag) { const tag = authTag; authTag = null; return [`${tag} OK authenticated\r\n`]; }
    const [tag, command] = line.split(" ");
    if (command === "CAPABILITY") return [`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n`];
    if (command === "AUTHENTICATE") { authTag = tag; return ["+ \r\n"]; }
    if (command === "EXAMINE" && options.examineResponse) return options.examineResponse({ tag, validity, uidNext });
    if (command === "EXAMINE") return [`* ${messages.size} EXISTS\r\n* OK [UIDVALIDITY ${validity}] stable\r\n` +
      `${options.noUidNext ? "" : `* OK [UIDNEXT ${uidNext}] next\r\n`}${options.notSticky ? "* NO [UIDNOTSTICKY] unstable\r\n" : ""}${tag} OK [READ-ONLY] done\r\n`];
    if (command === "LOGOUT") return [`* BYE done\r\n${tag} OK logout\r\n`];
    const search = /^\S+ UID SEARCH UID (\d+):(\d+)$/.exec(line);
    if (search) {
      const uids = options.search ?? [...messages.keys()].filter(uid => uid >= Number(search[1]) && uid <= Number(search[2]));
      return [`* SEARCH${uids.length ? " " + uids.join(" ") : ""}\r\n${tag} OK search\r\n`];
    }
    const fetch = /^\S+ UID FETCH (\d+) \(UID RFC822.SIZE INTERNALDATE FLAGS( BODY.PEEK\[\])?\)$/.exec(line);
    if (!fetch) throw new Error(`Unexpected fixture command: ${line}`);
    const uid = Number(fetch[1]), raw = messages.get(uid);
    if (!raw || options.disappeared === uid) return [`${tag} OK no message\r\n`];
    const reported = options.reportedSize ?? raw.length;
    if (!fetch[2] && options.metadataResponse) return options.metadataResponse({ tag, uid, raw, reported });
    if (!fetch[2]) return [`* ${options.sequence ?? 1} FETCH (FLAGS (\\Seen \\Flagged) UID ${uid} INTERNALDATE "29-Oct-2026 12:34:56 +0800" RFC822.SIZE ${reported})\r\n${tag} OK metadata\r\n`];
    if (options.bodyResponse) return options.bodyResponse({ tag, uid, raw, reported });
    // UID and other attributes deliberately follow the literal: attribute order is not a persistent identity.
    return [`* ${options.bodySequence ?? 9} FETCH (BODY[] {${raw.length}}\r\n`, raw,
      ` UID ${uid} FLAGS (\\Seen) RFC822.SIZE ${reported} INTERNALDATE "29-Oct-2026 12:34:56 +0800")\r\n${tag} OK fetched\r\n`];
  }
  function socket() {
    let controller, closed = false;
    const enqueue = parts => {
      for (const part of parts) {
        const bytes = typeof part === "string" ? encoder.encode(part) : part;
        for (let offset = 0; offset < bytes.length; offset += options.chunkSize ?? 13) controller.enqueue(bytes.slice(offset, offset + (options.chunkSize ?? 13)));
      }
    };
    return { opened: Promise.resolve(), closed: Promise.resolve(),
      readable: new ReadableStream({ start(value) { controller = value; enqueue(["* OK synthetic IMAP ready\r\n"]); } }),
      writable: new WritableStream({ write(value) {
        const line = new TextDecoder().decode(value).replace(/\r\n$/, ""); enqueue(handle(line));
        if (options.eofAfterBody && /BODY.PEEK\[\]/.test(line)) { closed = true; controller.close(); }
      } }),
      async close() { if (!closed) { closed = true; controller.close(); } } };
  }
  return { calls, handle, socket, messages };
}

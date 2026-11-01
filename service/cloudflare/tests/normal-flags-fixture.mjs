import { readScenario } from "./normal-read-fixture.mjs";

export function flagsScenario(options = {}) {
  const read = readScenario(options), calls = [];
  let flags = options.flags ?? ["\\Seen"], reads = 0;
  function handle(line) {
    calls.push(line);
    const tag = line.split(" ")[0];
    if (/^\S+ SELECT INBOX$/.test(line)) return [options.selectResponse?.(tag) ??
      `* 2 EXISTS\r\n* OK [UIDVALIDITY ${options.validity ?? "42"}] stable\r\n* OK [PERMANENTFLAGS (\\Seen \\Flagged)] allowed\r\n${tag} OK [READ-WRITE] selected\r\n`];
    const fetch = /^\S+ UID FETCH (\d+) \(UID FLAGS\)$/.exec(line);
    if (fetch) {
      reads++;
      if (options.flagsResponse) return options.flagsResponse({ tag, uid: Number(fetch[1]), flags, reads });
      return [`* 7 FETCH (FLAGS (${flags.join(" ")}) UID ${fetch[1]})\r\n${tag} OK flags\r\n`];
    }
    const store = /^\S+ UID STORE (\d+) ([+-])FLAGS\.SILENT \((\\Seen|\\Flagged)\)$/.exec(line);
    if (store) {
      if (!options.ignoreStore) flags = store[2] === "+" ? [...new Set([...flags, store[3]])] : flags.filter(flag => flag !== store[3]);
      return [options.storeResponse?.(tag) ?? `${tag} OK stored\r\n`];
    }
    return read.handle(line);
  }
  function socket() {
    let controller, closed = false;
    const enqueue = parts => { for (const part of parts) {
      const bytes = typeof part === "string" ? new TextEncoder().encode(part) : part;
      for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
    } };
    return { opened: Promise.resolve(), closed: Promise.resolve(),
      readable: new ReadableStream({ start(value) { controller = value; enqueue(["* OK synthetic ready\r\n"]); } }),
      writable: new WritableStream({ write(value) { enqueue(handle(new TextDecoder().decode(value).replace(/\r\n$/, ""))); } }),
      async close() { if (!closed) { closed = true; controller.close(); } } };
  }
  return { calls, handle, socket };
}

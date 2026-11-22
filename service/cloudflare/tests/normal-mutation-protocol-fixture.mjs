import { mailboxData } from "./normal-folder-inbox-fixture.mjs";
import { folderFlagsScenario } from "./normal-folder-flags-fixture.mjs";

export function mutationScenario(options = {}) {
  const mailboxes = options.mailboxes ?? mailboxData(), reader = folderFlagsScenario({ ...options, mailboxes });
  const calls = [], selected = new Map(), deleted = new Set(); let capabilities = 0;
  const decode = value => value.startsWith('"') ? value.slice(1, -1).replace(/\\(["\\])/g, "$1") : value;
  function handle(line, id = "single") {
    calls.push(line); const tag = line.split(" ")[0];
    if (/^\S+ CAPABILITY$/.test(line)) {
      capabilities++; const advertised = options.capabilities ?? "IMAP4rev1 AUTH=PLAIN UIDPLUS MOVE";
      return [`* CAPABILITY ${capabilities === 1 ? options.preAuthCapabilities ?? advertised : advertised}\r\n${tag} OK capabilities\r\n`];
    }
    const select = /^\S+ (?:SELECT|EXAMINE) (.+)$/.exec(line);
    if (select) {
      const name = decode(select[1]); selected.set(id, name);
      if (line.includes(" EXAMINE ") && options.examineResponse) return [options.examineResponse(tag)];
      const result = reader.handle(line, id);
      return result.map(value => typeof value === "string" && !options.selectResponse
        ? value.replace("PERMANENTFLAGS (\\Seen \\Flagged)", "PERMANENTFLAGS (\\Seen \\Flagged \\Deleted)") : value);
    }
    const name = selected.get(id), box = mailboxes.get(name), fetch = /^\S+ UID FETCH (\d+) \(UID FLAGS\)$/.exec(line);
    if (fetch && box) {
      const uid = Number(fetch[1]);
      if (options.flagsResponse) return options.flagsResponse({ tag, name, uid, box });
      return [box.messages.has(uid) ? `* 1 FETCH (UID ${uid} FLAGS (${reader.flags(name, uid).join(" ")}${deleted.has(`${name}:${uid}`) ? " \\Deleted" : ""}))\r\n${tag} OK flags\r\n` : `${tag} OK absent\r\n`];
    }
    const copy = /^\S+ UID (MOVE|COPY) (\d+) (.+)$/.exec(line);
    if (copy && box) {
      const uid = Number(copy[2]), destination = decode(copy[3]), target = mailboxes.get(destination), newUid = options.destinationUid ?? 501;
      if (!target || !box.messages.has(uid)) return [`${tag} NO absent\r\n`];
      if (!options.ignoreCopy) target.messages.set(newUid, box.messages.get(uid));
      if (copy[1] === "MOVE" && !options.keepSource) box.messages.delete(uid);
      return [options.copyResponse?.({ tag, uid, newUid, target, method: copy[1] }) ?? `* OK [COPYUID ${target.validity} ${uid} ${newUid}] copied\r\n${tag} OK done\r\n`];
    }
    const store = /^\S+ UID STORE (\d+) \+FLAGS\.SILENT \(\\Deleted\)$/.exec(line);
    if (store && box) {
      if (!options.ignoreDeleted) deleted.add(`${name}:${store[1]}`);
      return [options.storeResponse?.(tag) ?? `${tag} OK marked\r\n`];
    }
    const expunge = /^\S+ UID EXPUNGE (\d+)$/.exec(line);
    if (expunge && box) {
      if (deleted.has(`${name}:${expunge[1]}`) && !options.keepSource) box.messages.delete(Number(expunge[1]));
      return [options.expungeResponse?.(tag) ?? `* 1 EXPUNGE\r\n${tag} OK expunged\r\n`];
    }
    return reader.handle(line, id);
  }
  function socket() {
    let controller, closed = false;
    const enqueue = chunks => { for (const chunk of chunks) {
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
      for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
    } };
    return { opened: Promise.resolve(), closed: Promise.resolve(),
      readable: new ReadableStream({ start(value) { controller = value; enqueue(["* OK synthetic ready\r\n"]); } }),
      writable: new WritableStream({ write(value) { enqueue(handle(new TextDecoder().decode(value).replace(/\r\n$/, ""))); } }),
      async close() { if (!closed) { closed = true; controller.close(); } } };
  }
  return { calls, handle, socket, mailboxes, deleted };
}

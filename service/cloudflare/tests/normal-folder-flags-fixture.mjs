import assert from "node:assert/strict";
import { mailboxData, mailboxScenario, normalFolderInboxFixture } from "./normal-folder-inbox-fixture.mjs";

export function folderFlagsScenario(options = {}) {
  const data = options.mailboxes ?? mailboxData(), reader = mailboxScenario({ ...options, mailboxes: data });
  const selected = new Map(), flags = new Map(), calls = [], stores = [];
  const currentFlags = (name, uid) => { const key = `${name}:${uid}`; if (!flags.has(key)) flags.set(key, ["\\Seen"]); return flags.get(key); };
  function handle(line, id = "single") {
    calls.push(line); const tag = line.split(" ")[0], select = /^\S+ SELECT (.+)$/.exec(line);
    if (select) {
      const name = select[1].startsWith('"') ? select[1].slice(1, -1).replace(/\\(["\\])/g, "$1") : select[1];
      if (!data.has(name)) return [`${tag} NO no mailbox\r\n`];
      selected.set(id, name);
      return [options.selectResponse?.(tag) ?? `* OK [UIDVALIDITY ${data.get(name).validity}] stable\r\n* OK [PERMANENTFLAGS (\\Seen \\Flagged)] allowed\r\n${tag} OK [READ-WRITE] selected\r\n`];
    }
    const name = selected.get(id), box = data.get(name), fetch = /^\S+ UID FETCH (\d+) \(UID FLAGS\)$/.exec(line);
    if (fetch && box) {
      const uid = Number(fetch[1]);
      return [box.messages.has(uid) ? `* 1 FETCH (UID ${uid} FLAGS (${currentFlags(name, uid).join(" ")}))\r\n${tag} OK flags\r\n` : `${tag} OK absent\r\n`];
    }
    const store = /^\S+ UID STORE (\d+) ([+-])FLAGS\.SILENT \((\\Seen|\\Flagged)\)$/.exec(line);
    if (store && box) {
      const uid = Number(store[1]); stores.push({ name, uid, flag: store[3], value: store[2] === "+" });
      if (!box.messages.has(uid)) return [`${tag} NO absent\r\n`];
      const before = currentFlags(name, uid);
      flags.set(`${name}:${uid}`, store[2] === "+" ? [...new Set([...before, store[3]])] : before.filter(flag => flag !== store[3]));
      return [options.storeResponse?.(tag) ?? `${tag} OK stored\r\n`];
    }
    return reader.handle(line, id);
  }
  function socket() {
    let controller, closed = false;
    const enqueue = chunks => { for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk); };
    return { opened: Promise.resolve(), closed: Promise.resolve(),
      readable: new ReadableStream({ start(value) { controller = value; enqueue(["* OK synthetic ready\r\n"]); } }),
      writable: new WritableStream({ write(value) { enqueue(handle(new TextDecoder().decode(value).replace(/\r\n$/, ""))); } }),
      async close() { if (!closed) { closed = true; controller.close(); } } };
  }
  return { handle, socket, calls, stores, flags: currentFlags };
}
export async function folderFlagsFixture(options = {}) {
  const t = await normalFolderInboxFixture({ ...options, scenarioFactory: folderFlagsScenario });
  try {
    const name = options.folder ?? "Sent";
    assert.equal((await t.receive(name)).body.request.state, "committed");
    const item = (await t.messages(name)).body.items[0], folderId = t.folder(name).id;
    const path = `${t.folderPath(name)}/messages/${item.id}/remote-flags`;
    const body = { expectedRevision: 1, epochId: item.epochId, flag: "\\Flagged", value: true, acknowledgedUnknownId: null };
    return { ...t, item, folderId, path, body,
      write(key = crypto.randomUUID(), fields = {}, extra = {}) { return t.request(path, { method: "POST", headers: { "idempotency-key": key }, body: { ...body, ...fields }, ...extra }); },
      operation(key, extra = {}) { return t.request(`${t.folderPath(name)}/remote-flag-operations/${key}`, extra); },
      latest(extra = {}) { return t.request(path, extra); },
      message() { return t.request(`${t.folderPath(name)}/messages/${item.id}`); },
    };
  } catch (error) { await t.close(); throw error; }
}

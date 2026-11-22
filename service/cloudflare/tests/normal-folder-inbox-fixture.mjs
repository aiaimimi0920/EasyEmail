import assert from "node:assert/strict";
import { normalSyncFixture } from "./normal-sync-fixture.mjs";
import { readScenario } from "./normal-read-fixture.mjs";

const raw = (name, to) => new TextEncoder().encode(`From: Alice <alice@example.test>\r\nTo: ${to}\r\nSubject: ${name}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${name} body\r\n`);
export const mailboxData = () => new Map([
  ["INBOX", { validity: "42", uidNext: 8, messages: new Map([[2, raw("Inbox mail", "alice@example.test")]]) }],
  ["Sent", { validity: "42", uidNext: 8, messages: new Map([[2, raw("Sent mail", "bob@example.test")]]) }],
  ["&Ti1lhw-", { validity: "42", uidNext: 4, messages: new Map([[2, raw("Archive mail", "carol@example.test")]]) }],
]);
export function mailboxScenario(options = {}) {
  const data = options.mailboxes ?? mailboxData(), sessions = new Map();
  return { handle(line, id = "single") {
    const tag = line.split(" ")[0];
    if (/ LIST /.test(line)) return [...(options.rows ?? ['* LIST () "/" INBOX\r\n', '* LIST (\\Sent) "/" Sent\r\n',
      '* LIST (\\Archive) "/" "&Ti1lhw-"\r\n', '* LIST (\\Noselect) "/" Container\r\n']), `${tag} OK list complete\r\n`];
    if (!sessions.has(id)) sessions.set(id, readScenario(data.get("INBOX")));
    const match = /^\S+ EXAMINE (.+)$/.exec(line);
    if (match) {
      const name = match[1].startsWith('"') ? match[1].slice(1, -1).replace(/\\(["\\])/g, "$1") : match[1];
      if (!data.has(name)) return [`${tag} NO no mailbox\r\n`];
      sessions.set(id, readScenario(data.get(name)));
    }
    return sessions.get(id).handle(line);
  } };
}
export async function normalFolderInboxFixture(options = {}) {
  const t = await normalSyncFixture({ ...options, public: true, scenarioFactory: options.scenarioFactory ?? mailboxScenario });
  const base = `/api/v1/normal-accounts/${t.id}`, directory = await t.h.request(`${base}/server-folders/discover`, {
    method: "POST", cookie: t.alice.cookie, body: { expectedRevision: 1 } });
  assert.equal(directory.status, 200, directory.text);
  const folders = directory.body.catalog.items, folder = name => folders.find(row => row.wireName === name);
  const folderPath = name => `${base}/server-folders/${folder(name).id}`;
  const request = (path, extra = {}) => t.h.request(path, { cookie: t.alice.cookie, ...extra });
  return { ...t, base, folders, folder, folderPath, request,
    receive(name, key = crypto.randomUUID(), extra = {}) { return request(`${folderPath(name)}/sync`, { method: "POST",
      headers: { "idempotency-key": key }, body: { expectedRevision: 1 }, ...extra }); },
    messages(name, query = "", extra = {}) { return request(`${folderPath(name)}/messages${query}`, extra); },
  };
}

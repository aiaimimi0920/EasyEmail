import { readScenario } from "./normal-read-fixture.mjs";
import { normalSyncFixture } from "./normal-sync-fixture.mjs";

export const folderRows = [
  '* LIST (\\HasNoChildren) "/" INBOX\r\n',
  '* LIST (\\Junk) "/" "Spam"\r\n',
  '* LIST (\\Noselect \\HasChildren) "/" "Projects"\r\n',
  '* LIST (\\Sent) NIL "&Ti1lhw-"\r\n',
  '* LIST () "/" {8}\r\nLiteral!\r\n',
];
export function folderScenario(options = {}) {
  const original = readScenario(options);
  return { handle(line) {
    const tag = line.split(" ")[0];
    if (/ CAPABILITY$/.test(line) && options.specialUse) return [`* CAPABILITY IMAP4rev1 AUTH=PLAIN SPECIAL-USE\r\n${tag} OK ready\r\n`];
    if (/ LIST /.test(line)) return options.response?.(tag, line) ?? [...(options.rows ?? folderRows), `${tag} OK list complete\r\n`];
    return original.handle(line);
  } };
}
export async function normalFoldersFixture(options = {}) {
  const t = await normalSyncFixture({ ...options, public: true, scenarioFactory: folderScenario });
  const path = `/api/v1/normal-accounts/${t.id}/server-folders`;
  return { ...t, path,
    cached(extra = {}) { return t.h.request(path, { cookie: t.alice.cookie, ...extra }); },
    discover(revision = 1, extra = {}) { return t.h.request(`${path}/discover`, { method: "POST", cookie: t.alice.cookie, body: { expectedRevision: revision }, ...extra }); },
  };
}

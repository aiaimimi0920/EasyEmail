import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EasyEmailSnapshot } from "../../src/domain/models.js";
import { SqliteMailStateStore } from "../../src/persistence/sqlite-state-store.js";

const directories: string[] = [];
const pythonCommand = process.env.EASY_EMAIL_TEST_PYTHON || "python";
const helperScriptPath = resolve("src/persistence/helpers/sqlite_state_store.py");

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "easy-email-sqlite-"));
  directories.push(directory);
  return directory;
}

function snapshot(textBody: string): EasyEmailSnapshot {
  return {
    providerTypes: [], runtimeTemplates: [], instances: [], bindings: [], strategies: [],
    credentialSets: [], credentialBindings: [], sessions: [],
    messages: [{
      id: "message", sessionId: "session", providerInstanceId: "provider",
      observedAt: "2026-10-25T00:00:00.000Z", textBody,
    }],
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLite state store helper", () => {
  it("round trips a real snapshot larger than 1 MiB with Unicode intact", async () => {
    const directory = await temporaryDirectory();
    const store = new SqliteMailStateStore({
      databasePath: join(directory, "state.sqlite"), pythonCommand, helperScriptPath,
    });
    const textBody = "中文邮件🙂".repeat(100_000);
    await store.saveSnapshot(snapshot(textBody));
    expect((await store.loadSeed())?.messages?.[0]?.textBody).toBe(textBody);
    expect((await store.listObservedMessages({ limit: 1 }))[0]?.textBody).toBe(textBody);
    expect((await store.getStats()).observedMessageCount).toBe(1);
  }, 30_000);

  it("keeps the event loop responsive while a helper is running", async () => {
    const directory = await temporaryDirectory();
    const helper = join(directory, "slow.py");
    await writeFile(helper, "import time\ntime.sleep(0.3)\nprint('null')\n", "utf8");
    const store = new SqliteMailStateStore({
      databasePath: join(directory, "state.sqlite"), pythonCommand, helperScriptPath: helper,
    });
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 10);
    try {
      expect(await store.loadSeed()).toBeUndefined();
      expect(timerRan).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it("serializes across store instances and captures snapshots before queueing", async () => {
    const directory = await temporaryDirectory();
    const helper = join(directory, "ordered.py");
    await writeFile(helper, [
      "import json, pathlib, sys, time",
      "path = pathlib.Path(sys.argv[2])",
      "if sys.argv[1] == 'save':",
      "    data = json.load(sys.stdin)",
      "    if data['messages'][0]['textBody'] == 'first': time.sleep(0.3)",
      "    path.write_text(json.dumps(data), encoding='utf-8')",
      "    print('null')",
      "else:",
      "    data = json.loads(path.read_text(encoding='utf-8'))",
      "    print(json.dumps(data['messages']))",
    ].join("\n"), "utf8");
    const databasePath = join(directory, "state.json");
    const first = new SqliteMailStateStore({ databasePath, pythonCommand, helperScriptPath: helper });
    const second = new SqliteMailStateStore({
      databasePath: relative(process.cwd(), databasePath), pythonCommand, helperScriptPath: helper,
    });
    const firstSave = first.saveSnapshot(snapshot("first"));
    const next = snapshot("second");
    const secondSave = second.saveSnapshot(next);
    next.messages[0]!.textBody = "must not be persisted";
    const query = first.listObservedMessages();
    await Promise.all([firstSave, secondSave]);
    expect((await query)[0]?.textBody).toBe("second");
  });

  it("allows queued work to recover after a helper failure", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "state.sqlite");
    const failing = new SqliteMailStateStore({
      databasePath, pythonCommand, helperScriptPath: join(directory, "missing-secret-path.py"),
    });
    const valid = new SqliteMailStateStore({ databasePath, pythonCommand, helperScriptPath });
    const failure = expect(failing.loadSeed()).rejects.toMatchObject({ code: "SQLITE_HELPER_EXIT_FAILED" });
    const saved = valid.saveSnapshot(snapshot("recovered"));
    const loaded = valid.loadSeed();
    await failure;
    await saved;
    expect((await loaded)?.messages?.[0]?.textBody).toBe("recovered");
  });

  it("rejects excess queued work without starting more helpers", async () => {
    const directory = await temporaryDirectory();
    const helper = join(directory, "empty.py");
    await writeFile(helper, "print('null')\n", "utf8");
    const store = new SqliteMailStateStore({
      databasePath: join(directory, "state.sqlite"), pythonCommand, helperScriptPath: helper,
    });
    const pending = Array.from({ length: 64 }, () => store.loadSeed());
    const overflow = expect(store.loadSeed()).rejects.toMatchObject({ code: "SQLITE_HELPER_QUEUE_LIMIT" });
    await overflow;
    await Promise.all(pending);
    expect(await store.loadSeed()).toBeUndefined();
  }, 30_000);
});

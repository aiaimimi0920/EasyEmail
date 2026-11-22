import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSqliteHelper } from "../../src/persistence/sqlite-helper-process.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function run(source: string, options: Partial<Parameters<typeof runSqliteHelper>[0]> = {}) {
  return runSqliteHelper({ executable: process.execPath, args: ["-e", source], ...options });
}

describe("bounded SQLite helper process", () => {
  it("passes UTF-8 input and Python encoding settings without a shell", async () => {
    const result = await run(`
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => console.log(JSON.stringify({
        input, encoding: process.env.PYTHONIOENCODING,
        utf8: process.env.PYTHONUTF8, noBytecode: process.env.PYTHONDONTWRITEBYTECODE,
      })));
    `, { input: "中文邮件🙂" });
    expect(result).toEqual({ input: "中文邮件🙂", encoding: "utf-8", utf8: "1", noBytecode: "1" });
  });

  it("supports empty output and the exact stdout limit", async () => {
    expect(await run("process.stdin.resume()" )).toBeUndefined();
    expect(await run("process.stdout.write('1234')", { maxStdoutBytes: 4 })).toBe(1234);
  });

  it.each([
    ["stdout", "process.stdout.write('s'.repeat(4096))", "SQLITE_HELPER_STDOUT_LIMIT"],
    ["stderr", "process.stderr.write('secret'.repeat(1000))", "SQLITE_HELPER_STDERR_LIMIT"],
    ["timeout", "", "SQLITE_HELPER_TIMEOUT"],
  ])("terminates and reaps a child after %s exhaustion", async (_, source, code) => {
    const directory = await mkdtemp(join(tmpdir(), "easy-email-helper-process-"));
    directories.push(directory);
    const pidFile = join(directory, "pid");
    await expect(run(`
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      ${source};
      setInterval(() => {}, 1000);
    `, { timeoutMs: 2000, maxStdoutBytes: 1024, maxStderrBytes: 1024 })).rejects.toMatchObject({ code });
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);

  it("sanitizes spawn errors, exit errors and invalid JSON", async () => {
    await expect(run("", { executable: "missing-secret-executable" })).rejects.toMatchObject({
      message: "SQLITE_HELPER_SPAWN_FAILED",
    });
    await expect(run("process.stderr.write('secret'); process.exit(2)")).rejects.toMatchObject({
      message: "SQLITE_HELPER_EXIT_FAILED", exitCode: 2,
    });
    await expect(run("process.stdout.write('secret')")).rejects.toMatchObject({
      message: "SQLITE_HELPER_INVALID_JSON",
    });
  });

  it("handles early stdin closure without an unhandled stream error", async () => {
    await expect(run("process.exit(0)", { input: "x".repeat(16 * 1024 * 1024) })).rejects.toMatchObject({
      code: "SQLITE_HELPER_STDIN_FAILED",
    });
  });

  it("rejects invalid limits before spawning", async () => {
    await expect(run("", { timeoutMs: 0 })).rejects.toMatchObject({ code: "SQLITE_HELPER_INVALID_LIMIT" });
  });
});

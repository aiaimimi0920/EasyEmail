import { spawn } from "node:child_process";

export const SQLITE_HELPER_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 128 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export class SqliteHelperError extends Error {
  public constructor(
    public readonly code: string,
    public readonly exitCode?: number | null,
    public readonly signal?: string | null,
  ) {
    // Never attach command arguments, input, stderr, or a raw process error.
    super(code);
    this.name = "SqliteHelperError";
  }
}

export interface SqliteHelperProcessOptions {
  executable: string;
  args: string[];
  input?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export function runSqliteHelper<T>(options: SqliteHelperProcessOptions): Promise<T | undefined> {
  const timeoutMs = options.timeoutMs ?? SQLITE_HELPER_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? MAX_STDERR_BYTES;
  if (![timeoutMs, maxStdoutBytes, maxStderrBytes].every((n) => Number.isSafeInteger(n) && n > 0)) {
    return Promise.reject(new SqliteHelperError("SQLITE_HELPER_INVALID_LIMIT"));
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(options.executable, options.args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          PYTHONDONTWRITEBYTECODE: "1",
        },
      });
    } catch {
      reject(new SqliteHelperError("SQLITE_HELPER_SPAWN_FAILED"));
      return;
    }

    let failure: SqliteHelperError | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const chunks: Buffer[] = [];
    const fail = (code: string) => {
      if (!failure) {
        failure = new SqliteHelperError(code);
        chunks.length = 0;
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => fail("SQLITE_HELPER_TIMEOUT"), timeoutMs);
    child.once("error", () => fail("SQLITE_HELPER_SPAWN_FAILED"));
    child.stdin.on("error", () => fail("SQLITE_HELPER_STDIN_FAILED"));
    child.stdout.on("error", () => fail("SQLITE_HELPER_STDOUT_FAILED"));
    child.stderr.on("error", () => fail("SQLITE_HELPER_STDERR_FAILED"));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        fail("SQLITE_HELPER_STDOUT_LIMIT");
      } else if (!failure) {
        chunks.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) fail("SQLITE_HELPER_STDERR_LIMIT");
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) {
        reject(failure);
      } else if (code !== 0) {
        reject(new SqliteHelperError("SQLITE_HELPER_EXIT_FAILED", code, signal));
      } else {
        try {
          const output = Buffer.concat(chunks, stdoutBytes).toString("utf8").trim();
          resolve(output ? JSON.parse(output) as T : undefined);
        } catch {
          reject(new SqliteHelperError("SQLITE_HELPER_INVALID_JSON"));
        }
      }
      chunks.length = 0;
    });
    child.stdin.end(options.input);
  });
}

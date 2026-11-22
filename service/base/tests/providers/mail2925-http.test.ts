import type { ChildProcess, ExecFileException } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => childProcessMock);

import { requestJsonWithPython } from "../../src/providers/mail2925/http.js";

type ExecFileCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

function createMockChildProcess(onInput: (payload: string) => void = () => undefined): ChildProcess {
  return {
    stdin: {
      once(_event: string, _listener: () => void) {
        return this;
      },
      end(payload: string) {
        onInput(payload);
      },
    },
  } as unknown as ChildProcess;
}

describe("mail2925 Python HTTP fallback", () => {
  afterEach(() => {
    childProcessMock.execFile.mockReset();
  });

  it("bounds the helper process beyond the clamped request timeout", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    childProcessMock.execFile.mockImplementation((
      _command: string,
      _args: string[],
      options: Record<string, unknown>,
      callback: ExecFileCallback,
    ) => {
      capturedOptions = options;
      callback(null, '{"status":200,"body":{"ok":true}}', "");
      return createMockChildProcess();
    });

    await expect(requestJsonWithPython(
      "GET",
      "https://mail.2925.com/mailv2/messages",
      {},
      {},
      2,
    )).resolves.toEqual({ status: 200, body: { ok: true } });

    expect(capturedOptions).toMatchObject({
      timeout: 6_000,
      killSignal: "SIGKILL",
    });
  });

  it("keeps request credentials out of process arguments by writing them to stdin", async () => {
    const secret = "mail2925-process-list-secret";
    let capturedArgs: string[] | undefined;
    let capturedInput: string | undefined;
    childProcessMock.execFile.mockImplementation((
      _command: string,
      args: string[],
      _options: Record<string, unknown>,
      callback: ExecFileCallback,
    ) => {
      capturedArgs = args;
      queueMicrotask(() => callback(null, '{"status":200,"body":{}}', ""));
      return createMockChildProcess((payload) => {
        capturedInput = payload;
      });
    });

    await requestJsonWithPython(
      "GET",
      `https://mail.2925.com/messages?token=${secret}`,
      { Authorization: `Bearer ${secret}` },
      {},
      10,
    );

    expect(capturedArgs).toHaveLength(2);
    expect(capturedArgs?.join(" ")).not.toContain(secret);
    expect(capturedInput).toContain(secret);
  });

  it("tries the alternate Python command only when the executable is unavailable", async () => {
    childProcessMock.execFile
      .mockImplementationOnce((
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: ExecFileCallback,
      ) => {
        callback(Object.assign(new Error("spawn failed"), { code: "ENOENT" }), "", "");
        return createMockChildProcess();
      })
      .mockImplementationOnce((
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: ExecFileCallback,
      ) => {
        callback(null, '{"status":200,"body":{}}', "");
        return createMockChildProcess();
      });

    await expect(requestJsonWithPython(
      "GET",
      "https://mail.2925.com/messages",
      {},
      {},
      10,
    )).resolves.toEqual({ status: 200, body: {} });
    expect(childProcessMock.execFile).toHaveBeenCalledTimes(2);
  });

  it("classifies helper timeouts without leaking command output or request secrets", async () => {
    const secret = "mail2925-secret-canary";
    childProcessMock.execFile.mockImplementation((
      _command: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: ExecFileCallback,
    ) => {
      const error = Object.assign(new Error(`command included ${secret}`), {
        code: "ETIMEDOUT",
        killed: true,
      });
      callback(error, `stdout ${secret}`, `stderr ${secret}`);
      return createMockChildProcess();
    });

    const request = requestJsonWithPython(
      "GET",
      `https://mail.2925.com/messages?token=${secret}`,
      { Authorization: `Bearer ${secret}` },
      {},
      7,
    );

    await expect(request).rejects.toMatchObject({
      name: "Mail2925ClientError",
      kind: "transient",
      message: "2925 Python request timed out after 7s.",
    });
    await expect(request).rejects.not.toThrow(secret);
  });

  it("sanitizes non-timeout helper failures", async () => {
    const secret = "mail2925-stderr-secret";
    childProcessMock.execFile.mockImplementation((
      _command: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: ExecFileCallback,
    ) => {
      callback(new Error(`command included ${secret}`), "", `trace ${secret}`);
      return createMockChildProcess();
    });

    const request = requestJsonWithPython("GET", "https://mail.2925.com/messages", {}, {}, 10);

    await expect(request).rejects.toMatchObject({
      name: "Mail2925ClientError",
      kind: "provider",
      message: "2925 Python request helper failed.",
    });
    await expect(request).rejects.not.toThrow(secret);
  });

  it("kills the helper when writing its stdin fails", async () => {
    const kill = vi.fn();
    childProcessMock.execFile.mockImplementation((
      _command: string,
      _args: string[],
      _options: Record<string, unknown>,
      _callback: ExecFileCallback,
    ) => ({
      stdin: {
        once(_event: string, listener: () => void) {
          queueMicrotask(listener);
          return this;
        },
        end() {},
      },
      kill,
    }) as unknown as ChildProcess);

    await expect(requestJsonWithPython(
      "GET",
      "https://mail.2925.com/messages",
      {},
      {},
      10,
    )).rejects.toMatchObject({
      name: "Mail2925ClientError",
      kind: "provider",
      message: "2925 Python request helper failed.",
    });
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("rejects an empty successful helper response", async () => {
    childProcessMock.execFile.mockImplementation((
      _command: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: ExecFileCallback,
    ) => {
      callback(null, "", "");
      return createMockChildProcess();
    });

    await expect(requestJsonWithPython(
      "GET",
      "https://mail.2925.com/messages",
      {},
      {},
      10,
    )).rejects.toMatchObject({
      name: "Mail2925ClientError",
      kind: "provider",
      message: "2925 Python request helper returned an invalid response.",
    });
  });

  it("does not expose malformed helper output in parse errors", async () => {
    const secret = "mail2925-output-secret";
    childProcessMock.execFile.mockImplementation((
      _command: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: ExecFileCallback,
    ) => {
      callback(null, `not-json ${secret}`, "");
      return createMockChildProcess();
    });

    const request = requestJsonWithPython("GET", "https://mail.2925.com/messages", {}, {}, 10);

    await expect(request).rejects.toMatchObject({
      name: "Mail2925ClientError",
      kind: "provider",
      message: "2925 Python request helper returned invalid JSON.",
    });
    await expect(request).rejects.not.toThrow(secret);
  });

  it.each([
    "null",
    '{"status":"200","body":{}}',
    '{"status":700,"body":{}}',
  ])("rejects valid JSON that is not a provider response: %s", async (output) => {
    childProcessMock.execFile.mockImplementation((
      _command: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: ExecFileCallback,
    ) => {
      callback(null, output, "");
      return createMockChildProcess();
    });

    await expect(requestJsonWithPython(
      "GET",
      "https://mail.2925.com/messages",
      {},
      {},
      10,
    )).rejects.toMatchObject({
      name: "Mail2925ClientError",
      kind: "provider",
      message: "2925 Python request helper returned an invalid response.",
    });
  });
});

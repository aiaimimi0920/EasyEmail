let base = "";
let reportClose = false;
export function configureImapFixture(value: string, notifyClose = false) { base = value; reportClose = notifyClose; }
export function connect(address: unknown, options: unknown) {
  const fixtureBase = base, notifyClose = reportClose;
  let controller: ReadableStreamDefaultController<Uint8Array>, finished = false, resolveClosed: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const abort = new AbortController();
  const readable = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  async function call(path: string, body: unknown) {
    const response = await fetch(fixtureBase + path, { method: "POST", body: JSON.stringify(body), signal: abort.signal });
    if (!response.ok) throw new Error("synthetic transport failure");
    const value = await response.json() as { id?: string; chunks: (string | { base64: string })[] };
    for (const text of value.chunks) {
      const bytes = typeof text === "string" ? new TextEncoder().encode(text) : Uint8Array.from(atob(text.base64), char => char.charCodeAt(0));
      const fragment = typeof text === "string" ? 3 : 4093;
      for (let index = 0; index < bytes.length && !finished; index += fragment) controller!.enqueue(bytes.slice(index, index + fragment));
    }
    return value;
  }
  let id: string;
  const opened = call("/open", { address, options }).then(value => { id = value.id!; });
  const writable = new WritableStream<Uint8Array>({ async write(value) {
    await opened; await call("/command", { id, line: new TextDecoder().decode(value).replace(/\r\n$/, "") });
  } });
  return { readable, writable, opened, closed, async close() {
    if (!finished) {
      finished = true; abort.abort(); controller!.close(); resolveClosed!();
      if (notifyClose) await fetch(fixtureBase + "/close", { method: "POST", body: JSON.stringify({ id }) });
    }
  } };
}

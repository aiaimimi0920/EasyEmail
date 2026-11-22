let base = "";
export function configureSmtpFixture(value: string) { base = value; }
export function connect(address: unknown, options: unknown) {
  const fixture = base, abort = new AbortController();
  let controller: ReadableStreamDefaultController<Uint8Array>, finished = false, id = "", done: () => void;
  const closed = new Promise<void>(resolve => { done = resolve; });
  const readable = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  async function call(path: string, body: unknown) {
    const response = await fetch(fixture + path, { method: "POST", body: JSON.stringify(body), signal: abort.signal });
    if (!response.ok) throw new Error("synthetic SMTP transport failure");
    const value = await response.json() as { id?: string; chunks: string[]; eof?: boolean };
    for (const text of value.chunks) for (let n = 0; n < text.length && !finished; n += 3) controller!.enqueue(new TextEncoder().encode(text.slice(n, n + 3)));
    if (value.eof && !finished) { finished = true; controller!.close(); done!(); }
    return value;
  }
  const opened = call("/open", { address, options }).then(value => { id = value.id!; });
  const writable = new WritableStream<Uint8Array>({ async write(bytes) { await opened; await call("/write", { id, text: new TextDecoder().decode(bytes) }); } });
  return { readable, writable, opened, closed, async close() {
    abort.abort(); if (!finished) { finished = true; controller!.close(); done!(); }
  } };
}

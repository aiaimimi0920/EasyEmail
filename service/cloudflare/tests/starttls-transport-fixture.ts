let base = "";
export function configureStarttlsFixture(value: string) { base = value; }
interface Reply { id?: string; chunks?: { base64: string }[]; eof?: boolean }
export function connect(address: unknown, options: unknown) {
  const fixture = base; let id = "", upgraded = false;
  function socket(stage: "plain" | "tls") {
    const abort = new AbortController(); let controller: ReadableStreamDefaultController<Uint8Array>, finished = false, done: () => void;
    const closed = new Promise<void>(resolve => { done = resolve; });
    const readable = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const finish = () => { if (!finished) { finished = true; abort.abort(); controller!.close(); done!(); } };
    async function call(path: string, body: unknown) {
      const response = await fetch(fixture + path, { method: "POST", body: JSON.stringify(body), signal: abort.signal });
      if (!response.ok) throw new Error("synthetic STARTTLS peer failure");
      const value = await response.json() as Reply;
      for (const chunk of value.chunks ?? []) {
        const bytes = Uint8Array.from(atob(chunk.base64), c => c.charCodeAt(0));
        for (let n = 0; n < bytes.length && !finished; n += 13) controller!.enqueue(bytes.slice(n, n + 13));
      }
      if (value.eof) finish(); return value;
    }
    const opened = (stage === "plain" ? call("/open", { address, options }) : call("/upgrade", { id })).then(value => { id = value.id ?? id; });
    const writable = new WritableStream<Uint8Array>({ async write(bytes) {
      if (finished) throw new Error("synthetic obsolete socket write");
      await opened; await call("/write", { id, stage, text: new TextDecoder().decode(bytes) });
    } });
    return { readable, writable, opened, closed,
      startTls() {
        if (stage !== "plain" || upgraded || options && (options as { secureTransport?: string }).secureTransport !== "starttls") throw new Error("synthetic invalid upgrade");
        if (readable.locked || writable.locked) throw new Error("synthetic old stream lock");
        upgraded = true; finish(); return socket("tls");
      },
      async close() { finish(); await fetch(fixture + "/close", { method: "POST", body: JSON.stringify({ id, stage }) }); },
    };
  }
  return socket("plain");
}

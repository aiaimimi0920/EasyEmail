import assert from "node:assert/strict";
import { readScenario } from "./normal-read-fixture.mjs";

// Two distinct streams model Workers' one-shot replacement, not an in-place TLS flag.
export function starttlsPeer(protocol, mode = "normal") {
  const calls = [], sockets = [], reads = readScenario(), encoder = new TextEncoder();
  let upgrades = 0, data = false, authTag, resolveOpened, gate;
  function response(stage, text) {
    calls.push({ stage, text });
    if (protocol === "imap") {
      const [tag, command] = text.trimEnd().split(" ");
      if (command === "CAPABILITY") return [`* CAPABILITY IMAP4rev1 ${stage === "plain" ? (mode === "no-starttls" ? "AUTH=PLAIN" : "STARTTLS AUTH=PLAIN") : (mode === "no-auth" ? "STARTTLS" : "AUTH=PLAIN")}\r\n${tag} OK capability\r\n`];
      if (command === "STARTTLS") return [`${tag} ${mode === "reject" ? "NO rejected" : "OK upgrade"}\r\n${mode === "buffered" ? "* OK injected\r\n" : ""}`];
      assert.equal(stage, "tls", "IMAP credentials/INBOX must never use plaintext");
      if (command === "AUTHENTICATE") { authTag = tag; return ["+ \r\n"]; }
      if (authTag) { const tag = authTag; authTag = null; return [`${tag} OK authenticated\r\n`]; }
      return reads.handle(text.trimEnd());
    }
    if (text.startsWith("EHLO ")) return [stage === "plain"
      ? `250-synthetic\r\n250-${mode === "no-starttls" ? "SIZE 50000" : "STARTTLS"}\r\n250 AUTH PLAIN\r\n`
      : `250-synthetic\r\n250 ${mode === "no-auth" ? "SIZE 50000" : "AUTH PLAIN"}\r\n`];
    if (text === "STARTTLS\r\n") return [`${mode === "reject" ? "454 unavailable" : "220 upgrade"}\r\n${mode === "buffered" ? "250 injected\r\n" : ""}`];
    assert.equal(stage, "tls", "SMTP credentials/envelope must never use plaintext");
    if (text.startsWith("AUTH PLAIN ")) return ["235 authenticated\r\n"];
    if (text.startsWith("MAIL FROM:") || text.startsWith("RCPT TO:")) return ["250 ok\r\n"];
    if (text === "DATA\r\n") { data = true; return ["354 continue\r\n"]; }
    assert.equal(data, true); data = false;
    if (mode === "drop-final") return null;
    if (mode === "stall-final") return [];
    if (mode === "invalid-final") return ["250-incomplete\r\n550 inconsistent\r\n"];
    return [mode === "final-reject" ? "554 rejected\r\n" : "250 queued\r\n"];
  }
  function socket(stage) {
    let controller, ended = false;
    const emit = parts => {
      if (parts === null) { ended = true; controller.close(); return; }
      // Coalesce an injected plaintext suffix into the same read as STARTTLS completion.
      for (const part of parts) controller.enqueue(typeof part === "string" ? encoder.encode(part) : part);
    };
    const value = { stage, closes: 0,
      opened: stage === "tls" && mode === "opened-reject" ? Promise.reject(new Error("synthetic TLS failure"))
        : stage === "tls" && mode === "opened-stall" ? new Promise(resolve => { resolveOpened = resolve; }) : Promise.resolve(),
      closed: mode === "closed-reject" ? Promise.reject(new Error("synthetic closed failure")) : Promise.resolve(),
      readable: new ReadableStream({ start(c) { controller = c; if (stage === "plain") emit([protocol === "imap" ? "* OK ready\r\n" : "220 ready\r\n"]); } }),
      writable: new WritableStream({ async write(bytes) {
        assert.equal(ended, false, "old socket cannot be written after upgrade");
        const text = new TextDecoder().decode(bytes), chunks = response(stage, text);
        if (gate?.stage === stage && gate.pattern.test(text)) { const held = gate; gate = null; held.enter(); await held.wait; }
        if (!ended) emit(chunks);
      } }),
      async close() {
        value.closes++;
        if (mode === "linger-close") await new Promise(() => {});
        if (!ended) { ended = true; controller.close(); }
        if (mode === "close-reject") throw new Error("synthetic close failure");
        if (mode === "close-stall") await new Promise(() => {});
      },
      startTls() {
        assert.equal(stage, "plain"); assert.equal(++upgrades, 1);
        assert.equal(value.readable.locked, false); assert.equal(value.writable.locked, false);
        if (mode === "upgrade-throw") throw new Error("synthetic upgrade failure");
        ended = true; controller.close(); return socket("tls");
      },
    };
    sockets.push(value); return value;
  }
  return { calls, sockets, response, get upgrades() { return upgrades; }, releaseOpened() { resolveOpened?.(); },
    hold(stage, pattern) {
      let enter, release; const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
      gate = { stage, pattern, enter, wait }; return { entered, release };
    },
    connect(address, options) { calls.push({ address, options }); return socket("plain"); } };
}

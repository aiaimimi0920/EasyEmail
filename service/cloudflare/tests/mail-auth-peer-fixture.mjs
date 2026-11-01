import assert from "node:assert/strict";
import { readScenario } from "./normal-read-fixture.mjs";

// Only synthetic SASL peers. TLS here is stream replacement, never a real handshake.
export function mailAuthPeer(protocol, security = "tls", options = {}) {
  const calls = [], sockets = [], credentials = [], reads = options.imapScenario ?? readScenario(options.read), encoder = new TextEncoder();
  const challenge = Buffer.from(JSON.stringify({ status: "401", schemes: "bearer", scope: "synthetic-private-error" })).toString("base64");
  let upgrades = 0, auth, data = false, gate;
  function finishAuth() {
    const tag = auth.tag; auth = null;
    if (options.mode === "bye") return protocol === "imap" ? ["* BYE synthetic-private-error\r\n"] : ["421 synthetic-private-error\r\n"];
    if (options.mode === "reject") return [protocol === "imap" ? `${tag} NO synthetic-private-error\r\n` : "535 synthetic-private-error\r\n"];
    if (options.mode === "stall") return [];
    return [protocol === "imap" ? `${tag} OK authenticated\r\n` : "235 authenticated\r\n"];
  }
  function acceptCredential(value) {
    credentials.push({ method: auth.method, value: Buffer.from(value, "base64").toString("utf8") });
    if (["error", "error-ok", "double-error", "error-stall"].includes(options.mode)) {
      auth.ack = true; return [protocol === "imap" ? `+ ${challenge}\r\n` : `334 ${challenge}\r\n`];
    }
    return finishAuth();
  }
  function response(stage, text) {
    calls.push({ stage, text });
    if (auth) {
      if (!auth.ack) return acceptCredential(text.trimEnd());
      assert.equal(text, "\r\n", "error challenge receives only an empty response, never a credential replay");
      if (options.mode === "double-error") return [protocol === "imap" ? `+ ${challenge}\r\n` : `334 ${challenge}\r\n`];
      if (options.mode === "error-stall") return [];
      const tag = auth.tag; auth = null;
      return [protocol === "imap" ? `${tag} ${options.mode === "error-ok" ? "OK" : "NO"} synthetic-private-error\r\n`
        : `${options.mode === "error-ok" ? 235 : 535} synthetic-private-error\r\n`];
    }
    const capabilities = stage === "plain" ? options.before ?? "STARTTLS AUTH=PLAIN AUTH=XOAUTH2 SASL-IR"
      : options.after ?? `AUTH=PLAIN AUTH=XOAUTH2${options.saslIr === false ? "" : " SASL-IR"}`;
    if (protocol === "imap") {
      const [tag, command, method, initial] = text.trimEnd().split(" ");
      if (command === "CAPABILITY") return [`* CAPABILITY IMAP4rev1 ${capabilities}\r\n${tag} OK capability\r\n`];
      if (command === "STARTTLS") return [`${tag} OK upgrade\r\n`];
      if (command === "AUTHENTICATE") {
        assert.equal(stage, "tls", "credentials must only enter TLS"); auth = { tag, method };
        if (options.unsolicited) { auth = null; return [`${tag} OK unsolicited\r\n`]; }
        if (options.earlyChallenge) { auth.ack = true; return [`+ ${challenge}\r\n`]; }
        return initial ? acceptCredential(initial) : ["+ \r\n"];
      }
      return reads.handle(text.trimEnd());
    }
    if (text.startsWith("EHLO ")) return [`250-synthetic\r\n${stage === "plain" && /\bSTARTTLS\b/.test(capabilities) ? "250-STARTTLS\r\n" : ""}250 AUTH ${[...capabilities.matchAll(/AUTH=(\S+)/gi)].map(m => m[1]).join(" ")}\r\n`];
    if (text === "STARTTLS\r\n") return ["220 upgrade\r\n"];
    if (text.startsWith("AUTH ")) {
      assert.equal(stage, "tls", "credentials must only enter TLS"); const [, method, initial] = text.trimEnd().split(" "); auth = { method };
      if (options.mode === "plain-challenge" && method === "PLAIN") return ["334 \r\n"];
      return acceptCredential(initial);
    }
    if (text.startsWith("MAIL FROM:") || text.startsWith("RCPT TO:")) return ["250 ok\r\n"];
    if (text === "DATA\r\n") { data = true; return ["354 continue\r\n"]; }
    assert.equal(data, true); data = false;
    if (options.final === "drop") return null;
    if (options.final === "stall") return [];
    return [options.final === "reject" ? "554 rejected\r\n" : "250 queued\r\n"];
  }
  function socket(stage, initial = false) {
    let controller, ended = false, pendingReads = 0;
    const completedWrites = [];
    const emit = chunks => {
      if (chunks === null) { ended = true; controller.close(); return; }
      for (const chunk of chunks) {
        const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
        for (let offset = 0; offset < bytes.length; offset += options.chunkSize ?? 11) controller.enqueue(bytes.slice(offset, offset + (options.chunkSize ?? 11)));
      }
    };
    const readable = new ReadableStream({ start(c) { controller = c; if (initial) emit([protocol === "imap" ? "* OK synthetic\r\n" : "220 synthetic\r\n"]); } });
    const getReader = readable.getReader.bind(readable);
    readable.getReader = (...args) => {
      const reader = getReader(...args), read = reader.read.bind(reader);
      reader.read = (...args) => { pendingReads++; return read(...args).finally(() => { pendingReads--; }); }; return reader;
    };
    const value = { stage, closes: 0, completedWrites, get pendingReads() { return pendingReads; }, opened: Promise.resolve(), closed: Promise.resolve(), readable,
      writable: new WritableStream({ async write(bytes) {
        assert.equal(ended, false); const text = new TextDecoder().decode(bytes), chunks = response(stage, text);
        if (gate?.pattern.test(text)) {
          const held = gate; gate = null; held.enter();
          if (held.readOnly) { completedWrites.push(text); void held.wait.then(() => { if (!ended) emit(chunks); }); return; }
          await held.wait;
        }
        if (!ended) emit(chunks);
        completedWrites.push(text);
      } }),
      async close() { value.closes++; if (options.lingerClose) return new Promise(() => {}); if (!ended) { ended = true; controller.close(); } },
      startTls() { assert.equal(stage, "plain"); assert.equal(++upgrades, 1); assert.equal(value.readable.locked || value.writable.locked, false);
        ended = true; controller.close(); return socket("tls"); },
    };
    sockets.push(value); return value;
  }
  return { calls, sockets, credentials, response, get upgrades() { return upgrades; },
    hold(pattern, readOnly = false) { let enter, release; const entered = new Promise(r => { enter = r; }), wait = new Promise(r => { release = r; });
      gate = { pattern, enter, wait, readOnly }; return { entered, release }; },
    connect(address, options) { calls.push({ address, options }); return socket(security === "starttls" ? "plain" : "tls", true); } };
}

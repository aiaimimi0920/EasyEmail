import { HttpError } from "./http";
import { ImapResponseReader } from "./normal-imap-reader";
import type { MailSocketControl } from "./mail-socket-session";

export interface ImapSocket {
  opened: Promise<unknown>; closed: Promise<unknown>;
  readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>;
  close(): Promise<unknown>;
}
export class ImapWire {
  private reader: ImapResponseReader;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private sequence = 0;
  completion = "";
  constructor(public socket: ImapSocket, maxBytes = 65536, private control?: MailSocketControl) {
    this.reader = new ImapResponseReader(socket.readable, maxBytes); this.writer = socket.writable.getWriter();
  }
  line(allowLiteral = false) { return this.reader.line(allowLiteral); }
  literal(length: number) { return this.reader.literal(length); }
  write(line: string) { this.control?.assertActive(); return this.writer.write(new TextEncoder().encode(line + "\r\n")); }
  get needsStartTls() { return !!this.control?.upgrade; }
  async startTls() {
    if (!this.control?.upgrade) throw new HttpError(502, "imap_protocol_invalid");
    const remaining = this.reader.upgradeBudget();
    this.release(); this.socket = this.control.upgrade();
    this.reader = new ImapResponseReader(this.socket.readable, remaining); this.writer = this.socket.writable.getWriter();
    await this.socket.opened; this.control.assertActive();
  }
  async start(command: string) { const tag = `ee${++this.sequence}`; await this.write(`${tag} ${command}`); return tag; }
  async command(command: string, authValue?: string) {
    const tag = await this.start(command), lines: string[] = [];
    let challenged = false;
    for (let count = 0; count < 100; count++) {
      const line = await this.line();
      if (line.startsWith("+")) {
        if (authValue === undefined || challenged) throw new HttpError(502, "imap_protocol_invalid");
        challenged = true; await this.write(authValue); continue;
      }
      if (line.startsWith(`${tag} `)) {
        if (!new RegExp(`^${tag} OK(?: |$)`, "i").test(line)) throw new HttpError(authValue === undefined ? 502 : 403, authValue === undefined ? "imap_command_failed" : "imap_auth_failed");
        if (authValue !== undefined && !challenged) throw new HttpError(502, "imap_protocol_invalid");
        this.completion = line;
        return lines;
      }
      if (!line.startsWith("* ") || /^\* BYE(?: |$)/i.test(line)) throw new HttpError(502, "imap_connection_closed");
      lines.push(line);
    }
    throw new HttpError(502, "imap_response_limit");
  }
  release() {
    this.reader.release();
    try { this.writer.releaseLock(); } catch { /* Socket close owns pending writes. */ }
  }
}

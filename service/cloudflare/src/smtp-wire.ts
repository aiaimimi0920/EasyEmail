import { HttpError } from "./http";
import type { MailSocketControl } from "./mail-socket-session";

export interface SmtpSocket { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; opened: Promise<unknown> }
export class SmtpWire {
  private reader; private writer; private buffer = ""; private received = 0;
  constructor(socket: SmtpSocket, private control?: MailSocketControl) { this.reader = socket.readable.getReader(); this.writer = socket.writable.getWriter(); }
  async write(value: string) { this.control?.assertActive(); await this.writer.write(new TextEncoder().encode(value)); }
  get needsStartTls() { return !!this.control?.upgrade; }
  async startTls() {
    if (this.buffer || !this.control?.upgrade) throw new HttpError(502, "smtp_protocol_invalid");
    this.release(); const socket = this.control.upgrade();
    this.reader = socket.readable.getReader(); this.writer = socket.writable.getWriter();
    await socket.opened; this.control.assertActive();
  }
  private async line() {
    while (true) {
      const end = this.buffer.indexOf("\r\n");
      if (end >= 0) {
        if (end > 510) throw new HttpError(502, "smtp_protocol_invalid");
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 2);
        if (/[^\x20-\x7e]/.test(line)) throw new HttpError(502, "smtp_protocol_invalid");
        return line;
      }
      if (this.buffer.length > 512) throw new HttpError(502, "smtp_response_limit");
      const next = await this.reader.read(); if (next.done) throw new HttpError(502, "smtp_connection_closed");
      this.received += next.value.byteLength;
      if (this.received > 65536) throw new HttpError(502, "smtp_response_limit");
      this.buffer += String.fromCharCode(...next.value);
    }
  }
  async reply() {
    let code = ""; const lines: string[] = [];
    for (let count = 0; count < 100; count++) {
      const match = /^([2-5][0-9]{2})([- ])(.*)$/.exec(await this.line());
      if (!match || (code && code !== match[1])) throw new HttpError(502, "smtp_protocol_invalid");
      code = match[1]; lines.push(match[3]);
      if (match[2] === " ") return { code: Number(code), lines };
    }
    throw new HttpError(502, "smtp_response_limit");
  }
  release() {
    try { this.reader.releaseLock(); } catch { /* Socket close owns pending reads. */ }
    try { this.writer.releaseLock(); } catch { /* Socket close owns pending writes. */ }
  }
}

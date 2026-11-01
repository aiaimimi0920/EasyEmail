import { HttpError } from "./http";

// Owns byte framing only. Protocol lines and RFC822 literals never share a text decoder.
export class ImapResponseReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = new Uint8Array(0);
  private bytes = 0;
  private scanned = 0;
  constructor(stream: ReadableStream<Uint8Array>, private maxBytes: number) { this.reader = stream.getReader(); }
  private async append() {
    const chunk = await this.reader.read();
    if (chunk.done) throw new HttpError(502, "imap_connection_closed");
    this.bytes += chunk.value.byteLength;
    if (this.bytes > this.maxBytes) throw new HttpError(502, "imap_response_limit");
    const combined = new Uint8Array(this.buffer.length + chunk.value.byteLength);
    combined.set(this.buffer); combined.set(chunk.value, this.buffer.length); this.buffer = combined;
  }
  async line(allowLiteral = false): Promise<string> {
    for (;;) {
      for (let index = this.scanned; index < this.buffer.length - 1; index++) {
        if (this.buffer[index] !== 13 || this.buffer[index + 1] !== 10) continue;
        if (index > 8192) throw new HttpError(502, "imap_response_limit");
        const line = new TextDecoder().decode(this.buffer.subarray(0, index));
        this.buffer = this.buffer.subarray(index + 2); this.scanned = 0;
        if (/[\x00-\x08\x0a-\x1f\x7f]/.test(line) || (!allowLiteral && /\{\d+\+?\}$/.test(line))) throw new HttpError(502, "imap_protocol_invalid");
        return line;
      }
      this.scanned = Math.max(0, this.buffer.length - 1);
      if (this.buffer.length > 8193 || (this.buffer.length === 8193 && this.buffer.at(-1) !== 13)) throw new HttpError(502, "imap_response_limit");
      await this.append();
    }
  }
  async literal(length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0 || length > 2 * 1024 * 1024) throw new HttpError(502, "imap_response_limit");
    const result = new Uint8Array(length); let offset = 0;
    while (offset < length) {
      if (!this.buffer.length) await this.append();
      const take = Math.min(length - offset, this.buffer.length);
      result.set(this.buffer.subarray(0, take), offset); this.buffer = this.buffer.subarray(take); offset += take;
    }
    this.scanned = 0; return result;
  }
  upgradeBudget() {
    if (this.buffer.length) throw new HttpError(502, "imap_protocol_invalid");
    return this.maxBytes - this.bytes;
  }
  release() { try { this.reader.releaseLock(); } catch { /* Socket close owns pending reads. */ } }
}

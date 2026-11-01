import { connect } from "cloudflare:sockets";
import { HttpError } from "./http";

export interface MailSocket {
  opened: Promise<unknown>; closed: Promise<unknown>;
  readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>;
  close(): Promise<unknown>;
}
export interface MailSocketControl { assertActive(): void; upgrade?: () => MailSocket }

// One deadline and cleanup owner span both the original and replacement sockets.
export async function withMailSocket<T>(endpoint: { hostname: string; port: number; security?: "tls" | "starttls" },
  protocol: "imap" | "smtp", operation: (socket: MailSocket, control: MailSocketControl) => Promise<T>): Promise<T> {
  let socket: ReturnType<typeof connect> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<unknown> | undefined, stopped = false, upgraded = false;
  const timeout = () => new HttpError(504, `${protocol}_timeout`);
  const expiresAt = Date.now() + 15000;
  const assertActive = () => { if (stopped || Date.now() >= expiresAt) throw timeout(); };
  const close = () => closing ??= Promise.resolve().then(() => socket?.close()).catch(() => {});
  const observe = (value: ReturnType<typeof connect>) => { value.opened.catch(() => {}); value.closed.catch(() => {}); };
  try {
    socket = connect({ hostname: endpoint.hostname, port: endpoint.port },
      { secureTransport: endpoint.security === "starttls" ? "starttls" : "on", allowHalfOpen: false });
    observe(socket);
    const control: MailSocketControl = { assertActive };
    if (endpoint.security === "starttls") control.upgrade = () => {
      assertActive();
      if (upgraded) throw new HttpError(502, `${protocol}_protocol_invalid`);
      upgraded = true;
      const secure = socket!.startTls();
      socket = secure; observe(secure);
      return secure;
    };
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      stopped = true; void close(); reject(timeout());
    }, 15000); });
    return await Promise.race([operation(socket, control), deadline]);
  } finally {
    stopped = true; clearTimeout(timer);
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([close(), new Promise<void>(resolve => { cleanup = setTimeout(resolve, 1000); })]); }
    finally { clearTimeout(cleanup); }
  }
}

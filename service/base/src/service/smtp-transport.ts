import net, { type Socket } from "node:net";
import tls, { type TLSSocket } from "node:tls";

import type { MailAccountSmtpProfile } from "../domain/account.js";
import { EasyEmailError } from "../domain/errors.js";
import type {
  MailSmtpConnectionTestResult,
  MailSmtpSendEnvelope,
  MailSmtpSendResult,
  MailSmtpTransport,
} from "./account-connectivity.js";
import { buildSmtpMimeSubmission } from "./smtp-mime-encoder.js";

const DEFAULT_SMTP_TIMEOUT_MS = 15_000;
const MAX_SMTP_BUFFER_BYTES = 64 * 1024;
const EHLO_DOMAIN = "easyemail.local";

export interface NodeSmtpTransportOptions {
  timeoutMs?: number;
  tlsCa?: string | Buffer | ReadonlyArray<string | Buffer>;
  now?: () => Date;
}

interface SmtpReply {
  code: number;
  lines: string[];
  text: string;
}

function redactSecret(text: string, secret: string): string {
  const sanitized = secret ? text.split(secret).join("[redacted]") : text;
  return sanitized.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 512);
}

function classifySmtpReplyError(reply: SmtpReply, secret: string, context: string): EasyEmailError {
  const detail = redactSecret(reply.text, secret);
  if (reply.code === 535 || reply.code === 534 || reply.code === 530 || context === "auth") {
    return new EasyEmailError(
      "SMTP_AUTH_FAILED",
      "The SMTP server rejected the account credential.",
    );
  }
  if (reply.code >= 400 && reply.code < 500) {
    return new EasyEmailError(
      "SMTP_TRANSIENT_ERROR",
      `Temporary SMTP error (${reply.code}): ${detail || context}.`,
    );
  }
  return new EasyEmailError(
    "SMTP_PERMANENT_ERROR",
    `Permanent SMTP error (${reply.code}): ${detail || context}.`,
  );
}

function classifySocketError(error: unknown, secret: string): EasyEmailError {
  if (error instanceof EasyEmailError) {
    return error;
  }
  const message = error instanceof Error ? redactSecret(error.message, secret) : "SMTP connection failed.";
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "SMTP_STEP_TIMEOUT" || code === "ETIMEDOUT" || /timed?\s*out/i.test(message)) {
    return new EasyEmailError("SMTP_TIMEOUT", "The SMTP server timed out.");
  }
  if (typeof code === "string" && code.startsWith("ERR_TLS")) {
    return new EasyEmailError("SMTP_TLS_ERROR", `TLS negotiation failed: ${message}`);
  }
  return new EasyEmailError("SMTP_TRANSIENT_ERROR", `SMTP transport error: ${message}`);
}

class SmtpLineSession {
  private buffer = "";
  private socket: Socket | TLSSocket;

  public constructor(
    initialSocket: Socket | TLSSocket,
    private readonly timeoutMs: number,
  ) {
    this.socket = initialSocket;
  }

  public replaceSocket(nextSocket: TLSSocket): void {
    this.buffer = "";
    this.socket = nextSocket;
  }

  public destroy(): void {
    this.socket.destroy();
  }

  public async readReply(): Promise<SmtpReply> {
    const lines: string[] = [];
    while (true) {
      const line = await this.readLine();
      if (line.length < 3 || !/^\d{3}/.test(line)) {
        throw new EasyEmailError("SMTP_PROTOCOL_ERROR", "Malformed SMTP server response.");
      }
      const code = Number.parseInt(line.slice(0, 3), 10);
      const separator = line[3] ?? " ";
      lines.push(line.slice(4).trim());
      if (separator === " ") {
        return { code, lines, text: lines.join(" ") };
      }
      if (separator !== "-") {
        throw new EasyEmailError("SMTP_PROTOCOL_ERROR", "Malformed multiline SMTP response.");
      }
    }
  }

  public async sendCommand(command: string): Promise<SmtpReply> {
    await this.writeRaw(`${command}\r\n`);
    return this.readReply();
  }

  public async writeRaw(payload: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const timeoutErr = Object.assign(new Error("SMTP write timed out."), { code: "SMTP_STEP_TIMEOUT" });
        reject(timeoutErr);
      }, this.timeoutMs);
      this.socket.write(payload, "utf8", (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private readLine(): Promise<string> {
    const existingIndex = this.buffer.indexOf("\r\n");
    if (existingIndex >= 0) {
      const line = this.buffer.slice(0, existingIndex);
      this.buffer = this.buffer.slice(existingIndex + 2);
      return Promise.resolve(line);
    }
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off("data", onData);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
        this.socket.off("end", onClose);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(Object.assign(new Error("SMTP read timed out."), { code: "SMTP_STEP_TIMEOUT" }));
      }, this.timeoutMs);
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("SMTP connection closed unexpectedly."));
      };
      const onData = (chunk: Buffer | string) => {
        this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (this.buffer.length > MAX_SMTP_BUFFER_BYTES) {
          cleanup();
          reject(new EasyEmailError("SMTP_PROTOCOL_ERROR", "SMTP response exceeded maximum buffer size."));
          return;
        }
        const newlineIndex = this.buffer.indexOf("\r\n");
        if (newlineIndex >= 0) {
          const line = this.buffer.slice(0, newlineIndex);
          this.buffer = this.buffer.slice(newlineIndex + 2);
          cleanup();
          resolve(line);
        }
      };
      this.socket.on("data", onData);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
      this.socket.once("end", onClose);
    });
  }
}

export class NodeSmtpTransport implements MailSmtpTransport {
  private readonly timeoutMs: number;
  private readonly tlsCa?: string | Buffer | ReadonlyArray<string | Buffer>;
  private readonly now: () => Date;

  public constructor(options: NodeSmtpTransportOptions = {}) {
    const timeout = options.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000) {
      throw new Error("SMTP timeout must be an integer from 100 to 60000 milliseconds.");
    }
    this.timeoutMs = timeout;
    this.tlsCa = options.tlsCa;
    this.now = options.now ?? (() => new Date());
  }

  private async openAuthenticatedSession(
    profile: MailAccountSmtpProfile,
    secret: string,
  ): Promise<{ session: SmtpLineSession; capabilities: string[] }> {
    if (profile.security !== "tls" && profile.security !== "starttls") {
      throw new EasyEmailError("SMTP_SECURITY_UNSUPPORTED", "SMTP security must be tls or starttls.");
    }
    if (/[\r\n\u0000]/u.test(profile.username) || /[\r\n\u0000]/u.test(secret)) {
      throw new EasyEmailError("SMTP_AUTH_FAILED", "SMTP credentials contain unsupported control characters.");
    }

    const initialSocket = await this.connectInitialSocket(profile);
    const session = new SmtpLineSession(initialSocket, this.timeoutMs);
    try {
      const greeting = await session.readReply();
      if (greeting.code !== 220) {
        throw classifySmtpReplyError(greeting, secret, "greeting");
      }
      let ehlo = await session.sendCommand(`EHLO ${EHLO_DOMAIN}`);
      if (ehlo.code !== 250) {
        throw classifySmtpReplyError(ehlo, secret, "ehlo");
      }
      if (profile.security === "starttls") {
        const starttlsReply = await session.sendCommand("STARTTLS");
        if (starttlsReply.code !== 220) {
          throw classifySmtpReplyError(starttlsReply, secret, "starttls");
        }
        const upgraded = await this.upgradeSocketToTls(initialSocket, profile.host);
        session.replaceSocket(upgraded);
        ehlo = await session.sendCommand(`EHLO ${EHLO_DOMAIN}`);
        if (ehlo.code !== 250) {
          throw classifySmtpReplyError(ehlo, secret, "post-starttls-ehlo");
        }
      }

      const capabilities = ehlo.lines.slice(1).map((line) => line.trim()).filter(Boolean);
      await this.authenticate(session, capabilities, profile.username, secret);
      return { session, capabilities };
    } catch (error) {
      session.destroy();
      throw error;
    }
  }

  private connectInitialSocket(profile: MailAccountSmtpProfile): Promise<Socket | TLSSocket> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Object.assign(new Error("SMTP connect timed out."), { code: "SMTP_STEP_TIMEOUT" }));
      }, this.timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        socket.off("error", onError);
        resolve(socket);
      };
      const onError = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const socket = profile.security === "tls"
        ? tls.connect({
            host: profile.host,
            port: profile.port,
            ...(net.isIP(profile.host) === 0 ? { servername: profile.host } : {}),
            minVersion: "TLSv1.2",
            rejectUnauthorized: true,
            ...(this.tlsCa ? { ca: this.tlsCa as string | Buffer | Array<string | Buffer> } : {}),
          }, onReady)
        : net.connect({ host: profile.host, port: profile.port }, onReady);
      socket.once("error", onError);
    });
  }

  private upgradeSocketToTls(socket: Socket | TLSSocket, host: string): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        tlsSocket.destroy();
        reject(Object.assign(new Error("SMTP STARTTLS timed out."), { code: "SMTP_STEP_TIMEOUT" }));
      }, this.timeoutMs);
      const tlsSocket = tls.connect({
        socket: socket as Socket,
        ...(net.isIP(host) === 0 ? { servername: host } : {}),
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        ...(this.tlsCa ? { ca: this.tlsCa as string | Buffer | Array<string | Buffer> } : {}),
      }, () => {
        clearTimeout(timer);
        tlsSocket.off("error", onError);
        resolve(tlsSocket);
      });
      const onError = (error: Error) => {
        clearTimeout(timer);
        tlsSocket.destroy();
        reject(error);
      };
      tlsSocket.once("error", onError);
    });
  }

  private async authenticate(
    session: SmtpLineSession,
    capabilities: readonly string[],
    username: string,
    secret: string,
  ): Promise<void> {
    const authLine = capabilities.find((cap) => /^AUTH(?:\s|=)/i.test(cap))?.toUpperCase() ?? "";
    const supportsLoginOnly = /\bLOGIN\b/.test(authLine) && !/\bPLAIN\b/.test(authLine);
    if (supportsLoginOnly) {
      const step1 = await session.sendCommand("AUTH LOGIN");
      if (step1.code !== 334) throw classifySmtpReplyError(step1, secret, "auth");
      const step2 = await session.sendCommand(Buffer.from(username, "utf8").toString("base64"));
      if (step2.code !== 334) throw classifySmtpReplyError(step2, secret, "auth");
      const step3 = await session.sendCommand(Buffer.from(secret, "utf8").toString("base64"));
      if (step3.code !== 235) throw classifySmtpReplyError(step3, secret, "auth");
      return;
    }
    const token = Buffer.from(`\u0000${username}\u0000${secret}`, "utf8").toString("base64");
    const authReply = await session.sendCommand(`AUTH PLAIN ${token}`);
    if (authReply.code !== 235) {
      throw classifySmtpReplyError(authReply, secret, "auth");
    }
  }

  private async quitQuietly(session: SmtpLineSession): Promise<void> {
    try {
      await session.sendCommand("QUIT");
    } catch {
      // Ignore graceful QUIT errors after main operation completes.
    } finally {
      session.destroy();
    }
  }

  public async testConnection(
    profile: MailAccountSmtpProfile,
    secret: string,
  ): Promise<MailSmtpConnectionTestResult> {
    try {
      const { session, capabilities } = await this.openAuthenticatedSession(profile, secret);
      await this.quitQuietly(session);
      const summary = capabilities.length > 0
        ? capabilities.join(" ")
        : `${profile.host}:${profile.port} ${profile.security} authenticated`;
      return {
        authenticated: true,
        capabilitySummary: redactSecret(summary, secret),
      };
    } catch (error) {
      throw classifySocketError(error, secret);
    }
  }

  public async sendMessage(
    profile: MailAccountSmtpProfile,
    secret: string,
    envelope: MailSmtpSendEnvelope,
  ): Promise<MailSmtpSendResult> {
    const submission = buildSmtpMimeSubmission(envelope, this.now());
    try {
      const { session } = await this.openAuthenticatedSession(profile, secret);
      try {
        const mailReply = await session.sendCommand(`MAIL FROM:<${submission.mailFrom}>`);
        if (mailReply.code < 200 || mailReply.code >= 300) {
          throw classifySmtpReplyError(mailReply, secret, "mail-from");
        }
        for (const recipient of submission.rcptTo) {
          const rcptReply = await session.sendCommand(`RCPT TO:<${recipient}>`);
          if (rcptReply.code < 200 || rcptReply.code >= 300) {
            throw classifySmtpReplyError(rcptReply, secret, "rcpt-to");
          }
        }
        const dataReply = await session.sendCommand("DATA");
        if (dataReply.code !== 354) {
          throw classifySmtpReplyError(dataReply, secret, "data");
        }
        await session.writeRaw(`${submission.dotStuffedData}\r\n.\r\n`);
        const completeReply = await session.readReply();
        if (completeReply.code < 200 || completeReply.code >= 300) {
          throw classifySmtpReplyError(completeReply, secret, "data-complete");
        }
        const providerMessageId = redactSecret(completeReply.text, secret) || submission.rfcMessageId;
        return { providerMessageId };
      } finally {
        await this.quitQuietly(session);
      }
    } catch (error) {
      throw classifySocketError(error, secret);
    }
  }
}

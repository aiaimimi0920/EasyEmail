import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { EasyEmailError } from "../../domain/errors.js";
import {
  decodeMuseServiceFrame,
  decodeMuseServiceResponsePayload,
  decodeMuseTransportFrame,
  encodeMuseServiceFrameRequest,
  encodeMuseServiceRequest,
  encodeMuseTransportFrame,
} from "./muse-proto-wire.js";
import { NoiseAesGcmCipherState, NoiseXXInitiatorHandshake } from "./muse-noise-xx.js";

const DEFAULT_MUSE_ORIGIN = "https://www.muse.ai";
const DEFAULT_GATEWAY_URL = "wss://gateway.metaaivm.com/v1/noise";
const ALLOWED_READ_ONLY_ROUTES: Readonly<Record<string, string>> = {
  "email.mailbox.get": "/api/email/mailbox",
  "email.threads.list": "/api/email/threads",
  "email.threads.get": "/api/email/threads/{thread_id}",
};

export interface MuseMailStatusDto {
  loginStage: "idle" | "connected";
  bound: boolean;
  verifiedEmail: string;
  accountName: string;
  readOnly: true;
  memoryOnly: true;
  lastRefreshedAt: number;
}

export interface MuseThreadSummaryDto {
  id: string;
  subject: string;
  messageCount: number;
  participants: string[];
  lastFrom: string;
  preview: string;
  createdAtMs: number;
}

export interface MuseMessageDto {
  id: string;
  threadId: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string[];
  subject: string;
  createdAtMs: number;
  bodyText: string;
  museAuthVerdict?: string;
}

export interface MuseGatewayTransport {
  unaryGet(routeName: string, pathParam?: string, query?: Record<string, string>): Promise<Uint8Array>;
  close(): void;
}

export function buildMuseReadOnlyRoutePath(
  routeName: string,
  pathParam = "",
  query?: Record<string, string>,
): string {
  const tpl = ALLOWED_READ_ONLY_ROUTES[routeName];
  if (!tpl) {
    throw new EasyEmailError("MUSE_WRITE_FORBIDDEN", `Route '${routeName}' is forbidden by read-only allowlist.`);
  }
  let path = tpl;
  if (path.includes("{thread_id}")) {
    const cleanId = pathParam.trim();
    if (!cleanId) throw new EasyEmailError("INVALID_MUSE_THREAD_ID", "Muse thread id is required.");
    path = path.replace("{thread_id}", encodeURIComponent(cleanId));
  }
  if (query && Object.keys(query).length > 0) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) qs.set(k, v);
    const enc = qs.toString();
    if (enc) path += `?${enc}`;
  }
  return path;
}

export function normalizeVerifiedMuseAddress(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    throw new EasyEmailError("MUSE_EMAIL_NOT_ENABLED", "Invalid Muse mailbox identity payload.");
  }
  const m = raw as Record<string, unknown>;
  if (m.enabled === false) {
    throw new EasyEmailError("MUSE_EMAIL_NOT_ENABLED", "Muse mailbox is not enabled on this account.");
  }
  const sub = (m.mailbox && typeof m.mailbox === "object" ? m.mailbox : {}) as Record<string, unknown>;
  const candidates = [m.address, m.email, m.email_address, sub.address, sub.email];
  for (const cand of candidates) {
    if (typeof cand !== "string") continue;
    const low = cand.trim().toLowerCase();
    const at = low.lastIndexOf("@");
    if (at <= 0 || low.length > 254) continue;
    const domain = low.slice(at + 1);
    if (domain === "muse.ai" || domain.endsWith(".muse.ai")) return low;
  }
  throw new EasyEmailError("MUSE_EMAIL_NOT_ENABLED", "No verified @muse.ai address found.");
}

async function exchangeMuseHatchTokens(origin: string, cookieHeader: string) {
  const base = origin.replace(/\/+$/, "");
  const headers = (token = "") => ({
    accept: "application/json",
    "content-type": "application/json",
    origin: base,
    referer: `${base}/`,
    cookie: cookieHeader,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });

  const sessResp = await fetch(`${base}/api/session`, { method: "GET", headers: headers() });
  if (sessResp.status === 401 || sessResp.status === 403) {
    throw new EasyEmailError("MUSE_AUTH_EXPIRED", "Muse session cookie is unauthorized or expired.");
  }
  const sessJson = (await sessResp.json().catch(() => ({}))) as { vm_id?: string };
  const vmId = (sessJson.vm_id ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(vmId)) {
    throw new EasyEmailError("MUSE_GATEWAY_FAILED", "Muse personal VM instance is unavailable.");
  }

  const authResp = await fetch(`${base}/api/auth/check`, { method: "POST", headers: headers() });
  const authJson = (await authResp.json().catch(() => ({}))) as { access_token?: string };
  const accessToken = (authJson.access_token ?? "").trim();
  if (!authResp.ok || !accessToken) {
    throw new EasyEmailError("MUSE_AUTH_EXPIRED", "Failed to exchange Muse access token.");
  }

  const hatchResp = await fetch(`${base}/api/hatch/token`, {
    method: "POST",
    headers: headers(accessToken),
    body: JSON.stringify({ vmAddress: `wss://${vmId}.metaaivm.com/`, vmName: vmId }),
  });
  const hatchJson = (await hatchResp.json().catch(() => ({}))) as { token?: string };
  const hatchToken = (hatchJson.token ?? "").trim();
  if (!hatchResp.ok || !hatchToken) {
    throw new EasyEmailError("MUSE_GATEWAY_FAILED", "Failed to acquire Muse gateway hatch token.");
  }
  return { vmId, hatchToken };
}

class LiveNoiseWebSocketTransport implements MuseGatewayTransport {
  private streamId = 1n;
  private closed = false;
  private readonly pendingFrames: Uint8Array[] = [];
  private waiter: ((frame: Uint8Array) => void) | null = null;

  public constructor(
    private readonly ws: WebSocket,
    private readonly sendCipher: NoiseAesGcmCipherState,
    private readonly recvCipher: NoiseAesGcmCipherState,
  ) {
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(ev.data);
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(bytes);
      } else {
        this.pendingFrames.push(bytes);
      }
    });
  }

  private nextBinaryFrame(timeoutMs = 20000): Promise<Uint8Array> {
    if (this.pendingFrames.length > 0) return Promise.resolve(this.pendingFrames.shift()!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new EasyEmailError("MUSE_GATEWAY_TIMEOUT", "Timed out waiting for Muse gateway frame."));
      }, timeoutMs);
      this.waiter = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
    });
  }

  public async unaryGet(routeName: string, pathParam = "", query?: Record<string, string>): Promise<Uint8Array> {
    if (this.closed) throw new EasyEmailError("MUSE_DISCONNECTED", "Muse session is closed.");
    const path = buildMuseReadOnlyRoutePath(routeName, pathParam, query);
    const sid = this.streamId++;
    const sf = encodeMuseServiceFrameRequest(sid, {
      verb: "GET",
      path,
      headers: [{ key: "x-request-id", value: randomUUID() }],
      endBody: true,
    });
    const outer = encodeMuseServiceRequest(0, sf);
    const chunkId = randomBytes(8).readBigInt64LE(0) || 1n;
    const transportBytes = encodeMuseTransportFrame({
      chunkId,
      chunkIndex: 0,
      totalChunks: 1,
      payload: outer,
    });
    const encrypted = this.sendCipher.encryptWithAd(new Uint8Array(0), transportBytes);
    this.ws.send(encrypted);

    const bodyParts: Buffer[] = [];
    let status = 0;
    let done = false;
    while (!done) {
      const ct = await this.nextBinaryFrame();
      const pt = this.recvCipher.decryptWithAd(new Uint8Array(0), ct);
      const tf = decodeMuseTransportFrame(pt);
      const srPayload = decodeMuseServiceResponsePayload(tf.payload);
      const frame = decodeMuseServiceFrame(srPayload);
      if (frame.streamId !== sid) continue;
      if (frame.reset) throw new EasyEmailError("MUSE_GATEWAY_FAILED", frame.reset.reason || "Stream reset.");
      if (frame.response) {
        status = frame.response.status;
        if (frame.response.body.byteLength > 0) bodyParts.push(Buffer.from(frame.response.body));
        done = frame.response.endBody;
      } else if (frame.bodyChunk) {
        if (frame.bodyChunk.data.byteLength > 0) bodyParts.push(Buffer.from(frame.bodyChunk.data));
        done = frame.bodyChunk.endBody;
      }
    }
    if (status < 200 || status >= 300) {
      throw new EasyEmailError("MUSE_GATEWAY_FAILED", `Muse read-only endpoint returned HTTP ${status}.`);
    }
    return Buffer.concat(bodyParts);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sendCipher.wipe();
    this.recvCipher.wipe();
    this.pendingFrames.length = 0;
    try {
      this.ws.close();
    } catch {
      // Ignore close errors on teardown.
    }
  }
}

export class LocalMuseReadOnlyService {
  private session: MuseGatewayTransport | null = null;
  private verifiedEmail = "";
  private accountName = "Meta Muse (@muse.ai)";
  private lastRefreshedAt = 0;

  public constructor(
    private readonly connectorOverride?: (cookieHeader: string) => Promise<MuseGatewayTransport>,
  ) {}

  public getStatus(): MuseMailStatusDto {
    return {
      loginStage: this.session ? "connected" : "idle",
      bound: Boolean(this.session && this.verifiedEmail),
      verifiedEmail: this.verifiedEmail,
      accountName: this.accountName,
      readOnly: true,
      memoryOnly: true,
      lastRefreshedAt: this.lastRefreshedAt,
    };
  }

  public async connectReadOnlySession(input: {
    cookieHeader: string;
    accountName?: string;
    museOrigin?: string;
    gatewayUrl?: string;
  }): Promise<MuseMailStatusDto> {
    const cookie = input.cookieHeader.trim();
    if (!cookie) throw new EasyEmailError("MUSE_NOT_LOGGED_IN", "Muse session cookie is required.");
    this.disconnectAndWipe();

    let transport: MuseGatewayTransport;
    if (this.connectorOverride) {
      transport = await this.connectorOverride(cookie);
    } else {
      const origin = input.museOrigin?.trim() || DEFAULT_MUSE_ORIGIN;
      const gwBase = input.gatewayUrl?.trim() || DEFAULT_GATEWAY_URL;
      const tokens = await exchangeMuseHatchTokens(origin, cookie);
      const wsUrl = new URL(gwBase);
      wsUrl.searchParams.set("vm_id", tokens.vmId);
      wsUrl.searchParams.set("auth_token", tokens.hatchToken);
      const ws = new WebSocket(wsUrl.toString());
      ws.binaryType = "arraybuffer";
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new EasyEmailError("MUSE_GATEWAY_FAILED", "Muse WSS dial failed.")), { once: true });
      });
      const hs = new NoiseXXInitiatorHandshake();
      ws.send(hs.writeMessage1());
      const msg2 = await new Promise<Uint8Array>((resolve, reject) => {
        ws.addEventListener(
          "message",
          (ev) => (ev.data instanceof ArrayBuffer ? resolve(new Uint8Array(ev.data)) : reject(new Error("non-binary"))),
          { once: true },
        );
      });
      hs.readMessage2(msg2);
      const { msg3, sendCipher, recvCipher } = hs.writeMessage3();
      ws.send(msg3);
      transport = new LiveNoiseWebSocketTransport(ws, sendCipher, recvCipher);
    }

    try {
      const rawMailbox = await transport.unaryGet("email.mailbox.get");
      const parsed = JSON.parse(Buffer.from(rawMailbox).toString("utf8")) as Record<string, unknown>;
      const unwrapped = (parsed.result && typeof parsed.result === "object" ? parsed.result : parsed) as Record<string, unknown>;
      this.verifiedEmail = normalizeVerifiedMuseAddress(unwrapped);
      this.accountName = input.accountName?.trim() || this.verifiedEmail;
      this.session = transport;
      this.lastRefreshedAt = Date.now();
      return this.getStatus();
    } catch (error) {
      transport.close();
      throw error;
    }
  }

  public async listThreads(cursor?: string): Promise<{
    email: string;
    threads: MuseThreadSummaryDto[];
    nextCursor: string;
  }> {
    if (!this.session) throw new EasyEmailError("MUSE_DISCONNECTED", "Muse session is not connected.");
    const raw = await this.session.unaryGet("email.threads.list", "", cursor ? { cursor } : undefined);
    const root = JSON.parse(Buffer.from(raw).toString("utf8")) as Record<string, unknown>;
    const body = (root.result && typeof root.result === "object" ? root.result : root) as Record<string, unknown>;
    const list = Array.isArray(body.data) ? body.data : Array.isArray(body.threads) ? body.threads : [];
    const threads: MuseThreadSummaryDto[] = list.slice(0, 100).map((item) => {
      const m = (item ?? {}) as Record<string, unknown>;
      const last = (m.last_message && typeof m.last_message === "object" ? m.last_message : {}) as Record<string, unknown>;
      return {
        id: String(m.id ?? ""),
        subject: String(m.subject ?? "").slice(0, 512),
        messageCount: Math.max(1, Number(m.message_count ?? 1)),
        participants: Array.isArray(m.participants) ? m.participants.map(String).slice(0, 32) : [],
        lastFrom: String(last.header_from ?? "").slice(0, 254),
        preview: String(last.preview ?? m.preview ?? "").slice(0, 600),
        createdAtMs: Number(last.created_at ?? m.updated_at ?? 0),
      };
    }).filter((t) => t.id.length > 0);
    const paging = (body.paging && typeof body.paging === "object" ? body.paging : {}) as { cursors?: { after?: string } };
    this.lastRefreshedAt = Date.now();
    return {
      email: this.verifiedEmail,
      threads,
      nextCursor: String(paging.cursors?.after ?? ""),
    };
  }

  public async getThreadDetail(threadId: string): Promise<{
    id: string;
    subject: string;
    email: string;
    messages: MuseMessageDto[];
  }> {
    if (!this.session) throw new EasyEmailError("MUSE_DISCONNECTED", "Muse session is not connected.");
    const raw = await this.session.unaryGet("email.threads.get", threadId);
    const root = JSON.parse(Buffer.from(raw).toString("utf8")) as Record<string, unknown>;
    const body = (root.result && typeof root.result === "object" ? root.result : root) as Record<string, unknown>;
    const items = Array.isArray(body.messages) ? body.messages : [];
    const messages: MuseMessageDto[] = items.slice(0, 200).map((item, idx) => {
      const m = (item ?? {}) as Record<string, unknown>;
      const from = String(m.header_from ?? "");
      const authObj = (m.sender_authentication && typeof m.sender_authentication === "object"
        ? m.sender_authentication
        : {}) as { verdict?: string };
      return {
        id: String(m.id || `${threadId}#${idx + 1}`),
        threadId,
        direction: from.toLowerCase().includes(this.verifiedEmail) ? "outbound" : "inbound",
        from,
        to: Array.isArray(m.header_to) ? m.header_to.map(String) : [],
        subject: String(m.subject ?? body.subject ?? ""),
        createdAtMs: Number(m.created_at ?? 0),
        bodyText: String(m.text_body ?? m.extracted_text ?? m.preview ?? ""),
        ...(authObj.verdict ? { museAuthVerdict: String(authObj.verdict) } : {}),
      };
    });
    return {
      id: threadId,
      subject: String(body.subject ?? messages[0]?.subject ?? ""),
      email: this.verifiedEmail,
      messages,
    };
  }

  public disconnectAndWipe(): void {
    if (this.session) {
      this.session.close();
      this.session = null;
    }
    this.verifiedEmail = "";
    this.lastRefreshedAt = 0;
  }
}

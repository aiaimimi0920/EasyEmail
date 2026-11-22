import { lookup as nodeDnsLookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";

import { EasyEmailError } from "../domain/errors.js";

export const MAX_BIMI_AVATAR_BYTES = 128 * 1024;
export const MAX_FAVICON_AVATAR_BYTES = 256 * 1024;
export const MAX_CONTACT_AVATAR_BYTES = 512 * 1024;
export const MAX_AVATAR_REDIRECTS = 3;
const DEFAULT_FETCH_TIMEOUT_MS = 3_000;
const DEFAULT_DNS_TIMEOUT_MS = 2_000;

export interface AvatarDnsResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type AvatarDnsLookupFn = (hostname: string) => Promise<AvatarDnsResolvedAddress[]>;

export interface AvatarDownloadedResource {
  mime: string;
  bytes: Uint8Array;
  finalUrl: string;
}

export interface AvatarRemoteFetcher {
  downloadLimited(url: string, maxBytes: number): Promise<AvatarDownloadedResource>;
  lookupDnsTxtRecords(domainOrRecordName: string): Promise<string[]>;
}

export interface NodeSafeAvatarHttpFetcherOptions {
  timeoutMs?: number;
  dnsTimeoutMs?: number;
  maxRedirects?: number;
  dnsLookup?: AvatarDnsLookupFn;
  tlsCa?: https.RequestOptions["ca"];
  checkServerIdentity?: https.RequestOptions["checkServerIdentity"];
  connectOverride?: (target: {
    hostname: string;
    port: number;
    pinnedAddress: AvatarDnsResolvedAddress;
  }) => { connectHost: string; connectPort: number; connectFamily: 4 | 6 };
}

export function isPublicDnsName(rawDomain: string): boolean {
  const domain = rawDomain.trim().toLowerCase();
  if (
    !domain
    || domain.length > 253
    || !domain.includes(".")
    || domain.endsWith(".")
    || domain === "localhost"
    || domain.endsWith(".localhost")
    || domain.endsWith(".local")
    || domain.endsWith(".internal")
    || domain.endsWith(".home.arpa")
    || isIP(domain) !== 0
  ) {
    return false;
  }
  return domain.split(".").every(
    (label) =>
      label.length >= 1
      && label.length <= 63
      && !label.startsWith("-")
      && !label.endsWith("-")
      && /^[a-z0-9-]+$/u.test(label),
  );
}

export function isPublicIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function expandIpv6Segments(rawIp: string): number[] | undefined {
  const zoneless = rawIp.split("%")[0]?.trim().toLowerCase() ?? "";
  if (!zoneless) return undefined;
  let working = zoneless;
  if (working.includes(".")) {
    const lastColon = working.lastIndexOf(":");
    if (lastColon < 0) return undefined;
    const v4Part = working.slice(lastColon + 1);
    if (isIP(v4Part) !== 4) return undefined;
    const octets = v4Part.split(".").map((item) => Number.parseInt(item, 10));
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = working.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = halves.length === 2 ? 8 - (left.length + right.length) : 0;
  if ((halves.length === 1 && left.length !== 8) || missing < 0) return undefined;
  const full = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (full.length !== 8) return undefined;
  const nums = full.map((seg) => (/^[0-9a-f]{1,4}$/u.test(seg) ? Number.parseInt(seg, 16) : -1));
  return nums.some((n) => n < 0 || n > 0xffff) ? undefined : nums;
}

export function isPublicIpAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return isPublicIpv4(ip);
  }
  if (version !== 6) {
    return false;
  }
  const seg = expandIpv6Segments(ip);
  if (!seg) return false;
  const isIpv4Mapped =
    seg[0] === 0 && seg[1] === 0 && seg[2] === 0 && seg[3] === 0 && seg[4] === 0 && seg[5] === 0xffff;
  if (isIpv4Mapped) {
    const v4 = `${seg[6]! >> 8}.${seg[6]! & 0xff}.${seg[7]! >> 8}.${seg[7]! & 0xff}`;
    return isPublicIpv4(v4);
  }
  if (seg[0]! < 0x2000 || seg[0]! > 0x3fff) {
    return false;
  }
  if (seg[0] === 0x2001) {
    if (seg[1] === 0x0db8 || seg[1] === 0x0000) return false;
    if ((seg[1]! & 0xfff0) === 0x0010 || (seg[1]! & 0xfff0) === 0x0020) return false;
  }
  if (seg[0] === 0x2002) {
    const embeddedV4 = `${seg[1]! >> 8}.${seg[1]! & 0xff}.${seg[2]! >> 8}.${seg[2]! & 0xff}`;
    return isPublicIpv4(embeddedV4);
  }
  return true;
}

export function isSafeAvatarHttpsUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    return false;
  }
  return isPublicDnsName(parsed.hostname);
}

export function validateSafeSvgBytes(bytes: Uint8Array): void {
  const text = Buffer.from(bytes).toString("utf8");
  if (!/<svg[\s>]/iu.test(text)) {
    throw new Error("SVG image payload does not contain an <svg> root.");
  }
  if (
    /<\s*(?:script|foreignobject|iframe|embed|object)\b/iu.test(text)
    || /\bon[a-z]+\s*=/iu.test(text)
    || /(?:javascript|vbscript|data\s*:\s*text\/html)\s*:/iu.test(text)
  ) {
    throw new Error("SVG avatar contains unsafe executable or active content.");
  }
}

export function normalizeAvatarImageMime(rawMime: string, urlPath = ""): string {
  const mime = rawMime.trim().toLowerCase();
  const lowerUrl = urlPath.toLowerCase();
  if (mime === "image/svg" || mime === "image/svg+xml") return "image/svg+xml";
  if (mime === "image/png" || (mime === "application/octet-stream" && lowerUrl.endsWith(".png"))) {
    return "image/png";
  }
  if (mime === "image/jpeg" || mime === "image/jpg") return "image/jpeg";
  if (
    mime === "image/x-icon"
    || mime === "image/vnd.microsoft.icon"
    || (mime === "application/octet-stream" && lowerUrl.endsWith(".ico"))
  ) {
    return "image/x-icon";
  }
  throw new Error(`Unsupported avatar image MIME type: ${mime || "empty"}.`);
}

export function formatAvatarDataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function parseAndValidateAvatarDataUrl(
  value: string,
  maxBytes: number = MAX_CONTACT_AVATAR_BYTES,
): { mime: string; bytes: Uint8Array } {
  const commaIdx = value.indexOf(",");
  if (commaIdx < 0) {
    throw new EasyEmailError("INVALID_AVATAR_DATA_URL", "Avatar image must be a base64 data URL.");
  }
  const meta = value.slice(0, commaIdx).trim();
  const payload = value.slice(commaIdx + 1).trim();
  if (!meta.toLowerCase().startsWith("data:") || !meta.toLowerCase().endsWith(";base64") || !payload) {
    throw new EasyEmailError("INVALID_AVATAR_DATA_URL", "Avatar image must be a base64 data URL.");
  }
  const rawMime = meta.slice("data:".length, meta.length - ";base64".length);
  let mime: string;
  try {
    mime = normalizeAvatarImageMime(rawMime);
  } catch (error) {
    throw new EasyEmailError(
      "AVATAR_MIME_UNSUPPORTED",
      error instanceof Error ? error.message : "Unsupported avatar MIME type.",
    );
  }
  const maxBase64Chars = Math.ceil((maxBytes + 2) / 3) * 4;
  if (payload.length > maxBase64Chars || !/^[A-Za-z0-9+/=\s]+$/u.test(payload)) {
    throw new EasyEmailError(
      payload.length > maxBase64Chars ? "AVATAR_IMAGE_TOO_LARGE" : "INVALID_AVATAR_DATA_URL",
      payload.length > maxBase64Chars
        ? "Avatar image exceeds maximum supported size."
        : "Avatar image base64 payload is invalid.",
    );
  }
  const decoded = Buffer.from(payload, "base64");
  if (decoded.byteLength === 0 || decoded.byteLength > maxBytes) {
    throw new EasyEmailError(
      decoded.byteLength > maxBytes ? "AVATAR_IMAGE_TOO_LARGE" : "INVALID_AVATAR_DATA_URL",
      decoded.byteLength > maxBytes
        ? "Avatar image exceeds maximum supported size."
        : "Avatar image payload is empty.",
    );
  }
  const bytes = new Uint8Array(decoded);
  if (mime === "image/svg+xml") {
    try {
      validateSafeSvgBytes(bytes);
    } catch (error) {
      throw new EasyEmailError(
        "INVALID_AVATAR_DATA_URL",
        error instanceof Error ? error.message : "Unsafe SVG avatar rejected.",
      );
    }
  }
  return { mime, bytes };
}

export class NodeSafeAvatarHttpFetcher implements AvatarRemoteFetcher {
  private readonly timeoutMs: number;
  private readonly dnsTimeoutMs: number;
  private readonly maxRedirects: number;
  private readonly dnsLookup: AvatarDnsLookupFn;

  public constructor(private readonly options: NodeSafeAvatarHttpFetcherOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.dnsTimeoutMs = options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? MAX_AVATAR_REDIRECTS;
    this.dnsLookup = options.dnsLookup ?? (async (hostname: string) => {
      const records = await nodeDnsLookup(hostname, { all: true, verbatim: true });
      return records
        .filter((item): item is { address: string; family: 4 | 6 } => item.family === 4 || item.family === 6)
        .map((item) => ({ address: item.address, family: item.family }));
    });
  }

  private async resolveValidatedPublicAddress(hostname: string): Promise<AvatarDnsResolvedAddress> {
    if (!isPublicDnsName(hostname)) {
      throw new Error("Target host is not a public DNS name.");
    }
    const records = await this.dnsLookup(hostname);
    if (records.length === 0) {
      throw new Error("DNS lookup returned no addresses.");
    }
    if (records.some((record) => !isPublicIpAddress(record.address))) {
      throw new Error("Target host resolved to a non-public IP address.");
    }
    return records[0]!;
  }

  private executePinnedHttpsGet(
    parsedUrl: URL,
    pinned: AvatarDnsResolvedAddress,
    maxBytes: number,
    timeoutMs: number,
    headers: Record<string, string>,
  ): Promise<{ statusCode: number; location?: string; contentType: string; bytes: Uint8Array }> {
    const port = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : 443;
    const target = this.options.connectOverride
      ? this.options.connectOverride({ hostname: parsedUrl.hostname, port, pinnedAddress: pinned })
      : { connectHost: pinned.address, connectPort: port, connectFamily: pinned.family };

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          protocol: "https:",
          hostname: parsedUrl.hostname,
          port: target.connectPort,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          method: "GET",
          servername: parsedUrl.hostname,
          agent: false,
          ca: this.options.tlsCa,
          ...(this.options.checkServerIdentity
            ? { checkServerIdentity: this.options.checkServerIdentity }
            : {}),
          headers: {
            "user-agent": "EasyEmail/0.1 sender-avatar-fetcher",
            ...headers,
          },
          lookup: (_host, opts, callback) => {
            if (opts && typeof opts === "object" && "all" in opts && opts.all) {
              callback(null, [{ address: target.connectHost, family: target.connectFamily }]);
              return;
            }
            callback(null, target.connectHost, target.connectFamily);
          },
        },
        (res) => {
          const statusCode = res.statusCode ?? 0;
          const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
          const rawCt = typeof res.headers["content-type"] === "string"
            ? res.headers["content-type"]
            : "application/octet-stream";
          const contentType = rawCt.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
          if (statusCode >= 300 && statusCode < 400) {
            res.resume();
            clearTimeout(timer);
            resolve({ statusCode, location, contentType, bytes: new Uint8Array(0) });
            return;
          }
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          res.on("data", (chunk: Buffer) => {
            totalBytes += chunk.byteLength;
            if (totalBytes > maxBytes) {
              clearTimeout(timer);
              req.destroy(new Error("Avatar download exceeded maximum size."));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            clearTimeout(timer);
            resolve({ statusCode, location, contentType, bytes: new Uint8Array(Buffer.concat(chunks)) });
          });
          res.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        },
      );
      const timer = setTimeout(() => {
        req.destroy(new Error("Avatar HTTPS request timed out."));
      }, timeoutMs);
      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.end();
    });
  }

  public async downloadLimited(url: string, maxBytes: number): Promise<AvatarDownloadedResource> {
    if (!isSafeAvatarHttpsUrl(url)) {
      throw new Error("Avatar URL is not a safe public HTTPS URL.");
    }
    let currentUrl = url;
    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      const parsed = new URL(currentUrl);
      if (!isSafeAvatarHttpsUrl(parsed.toString())) {
        throw new Error("Redirect target is not a safe public HTTPS URL.");
      }
      const pinned = await this.resolveValidatedPublicAddress(parsed.hostname);
      const response = await this.executePinnedHttpsGet(parsed, pinned, maxBytes, this.timeoutMs, {});
      if (response.statusCode >= 300 && response.statusCode < 400) {
        if (redirectCount >= this.maxRedirects) {
          throw new Error("Avatar download exceeded safe redirect limit.");
        }
        if (!response.location) {
          throw new Error("Avatar redirect response omitted Location header.");
        }
        const nextUrl = new URL(response.location, parsed).toString();
        if (!isSafeAvatarHttpsUrl(nextUrl)) {
          throw new Error("Avatar redirect target is not a safe public HTTPS URL.");
        }
        currentUrl = nextUrl;
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Avatar download failed with HTTP ${response.statusCode}.`);
      }
      return {
        mime: response.contentType,
        bytes: response.bytes,
        finalUrl: parsed.toString(),
      };
    }
    throw new Error("Avatar download exceeded safe redirect limit.");
  }

  public async lookupDnsTxtRecords(recordName: string): Promise<string[]> {
    const dohUrl = new URL("https://cloudflare-dns.com/dns-query");
    dohUrl.searchParams.set("name", recordName);
    dohUrl.searchParams.set("type", "TXT");
    const pinned = await this.resolveValidatedPublicAddress(dohUrl.hostname);
    const response = await this.executePinnedHttpsGet(
      dohUrl,
      pinned,
      64 * 1024,
      this.dnsTimeoutMs,
      { accept: "application/dns-json" },
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`DNS TXT lookup failed with HTTP ${response.statusCode}.`);
    }
    const parsed = JSON.parse(Buffer.from(response.bytes).toString("utf8")) as {
      Answer?: Array<{ data?: unknown }>;
    };
    return (parsed.Answer ?? [])
      .map((item) => (typeof item.data === "string" ? normalizeDnsTxtRecord(item.data) : ""))
      .filter(Boolean);
  }
}

export function normalizeDnsTxtRecord(rawValue: string): string {
  return rawValue
    .split('" "')
    .join("")
    .trim()
    .replace(/^"+|"+$/gu, "")
    .replaceAll('\\"', '"');
}

import type { Env } from "./contracts";
import { HttpError, json } from "./http";
import { imapEndpoints, type ImapEndpoint } from "./normal-account-input";
import {
  detectMailProviderPreset,
  listMailProviderPresets,
  type MailMxRecordInput,
  type MailProviderPreset,
} from "../../base/src/domain/mail-provider-presets";

const PUBLIC_DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PRIVATE_DOMAIN_RE = /(?:\.home\.arpa$|(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|onion|invalid|test|example)$)/;

function safeImapEndpoints(env: Env): ImapEndpoint[] {
  try {
    return imapEndpoints(env);
  } catch {
    return [];
  }
}

function matchConfiguredEndpointId(preset: MailProviderPreset | undefined, endpoints: readonly ImapEndpoint[]): string | null {
  if (!preset || !preset.defaultImapHost) return null;
  const exact = endpoints.find(
    (ep) => ep.hostname === preset.defaultImapHost.toLowerCase() && ep.port === preset.defaultImapPort,
  );
  if (exact) return exact.id;
  const hostOnly = endpoints.find((ep) => ep.hostname === preset.defaultImapHost.toLowerCase());
  return hostOnly?.id ?? null;
}

async function resolvePublicMxRecordsOverDoh(domain: string): Promise<MailMxRecordInput[]> {
  if (!PUBLIC_DOMAIN_RE.test(domain) || PRIVATE_DOMAIN_RE.test(domain)) {
    return [];
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const dohUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`;
    const response = await fetch(dohUrl, {
      method: "GET",
      headers: { accept: "application/dns-json" },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const payload = await response.json() as { Answer?: Array<{ type?: number; data?: string }> };
    const records: MailMxRecordInput[] = [];
    for (const answer of payload.Answer ?? []) {
      if (answer.type !== 15 || typeof answer.data !== "string") continue;
      const parts = answer.data.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const priority = Number.parseInt(parts[0] ?? "", 10);
      const exchange = (parts[1] ?? "").replace(/\.+$/, "").toLowerCase();
      if (Number.isSafeInteger(priority) && exchange) {
        records.push({ priority, exchange });
      }
    }
    return records;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function getCloudflareProviderPresetsResponse(env: Env): Response {
  const endpoints = safeImapEndpoints(env);
  const items = listMailProviderPresets(false).map((preset) => ({
    ...preset,
    matchedEndpointId: matchConfiguredEndpointId(preset, endpoints),
  }));
  return json({ items });
}

export async function detectCloudflareProviderPresetResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((k) => k !== "email" || url.searchParams.getAll(k).length !== 1)) {
    throw new HttpError(400, "invalid_filter");
  }
  const rawEmail = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!rawEmail || rawEmail.length > 254) {
    throw new HttpError(400, "invalid_filter");
  }
  const atIdx = rawEmail.lastIndexOf("@");
  const domain = (atIdx >= 0 ? rawEmail.slice(atIdx + 1) : rawEmail).replace(/\.+$/, "");
  if (!PUBLIC_DOMAIN_RE.test(domain)) {
    throw new HttpError(400, "invalid_filter");
  }

  const endpoints = safeImapEndpoints(env);
  let preset = detectMailProviderPreset(rawEmail);
  let mxRecords: MailMxRecordInput[] = [];
  if (!preset) {
    mxRecords = await resolvePublicMxRecordsOverDoh(domain);
    preset = detectMailProviderPreset(rawEmail, mxRecords);
  }
  const matchedEndpointId = matchConfiguredEndpointId(preset, endpoints);
  return json({
    preset: preset ?? null,
    matchedEndpointId,
    mxExchanges: mxRecords.slice(0, 5).map((r) => r.exchange),
  });
}

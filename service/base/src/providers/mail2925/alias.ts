import { randomBytes } from "node:crypto";

import { Mail2925ClientError } from "./failure.js";
import { normalizeAddress } from "./payload.js";
import type { Mail2925AccountCredential } from "./types.js";

function sanitizeAliasFragment(value: string | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return normalized || randomBytes(6).toString("hex").slice(0, 10);
}

export function sanitizeAliasSeparator(value: string | undefined): string {
  const normalized = (value ?? "_").trim();
  return /^[._-]{0,3}$/.test(normalized) ? normalized : "_";
}

export function normalizeAccountAddress(value: string, fallbackDomain: string): {
  username: string;
  accountEmail: string;
  localPart: string;
  domain: string;
} {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Mail2925ClientError("2925 credential username is empty.", "auth");
  }

  if (normalized.includes("@")) {
    const [localPartRaw, domainRaw] = normalized.split("@", 2);
    const localPart = localPartRaw.trim();
    const domain = domainRaw.trim() || fallbackDomain;
    if (!localPart || !domain) {
      throw new Mail2925ClientError(`2925 credential username "${value}" is invalid.`, "auth");
    }
    return {
      username: normalized,
      accountEmail: `${localPart}@${domain}`,
      localPart,
      domain,
    };
  }

  return {
    username: normalized,
    accountEmail: `${normalized}@${fallbackDomain}`,
    localPart: normalized,
    domain: fallbackDomain,
  };
}

export function buildAliasAddress(
  account: Mail2925AccountCredential,
  sessionHint: string,
  aliasSeparator: string,
  aliasSuffixLength: number,
  requestedDomain: string | undefined,
): string {
  const requested = normalizeAddress(requestedDomain);
  if (requested && requested !== account.domain) {
    throw new Mail2925ClientError(
      `2925 only supports aliases on ${account.domain}; requested ${requested}.`,
      "provider",
    );
  }

  const suffix = sanitizeAliasFragment(sessionHint).slice(0, Math.max(4, aliasSuffixLength));
  const separator = sanitizeAliasSeparator(aliasSeparator);
  const room = Math.max(1, 64 - account.localPart.length - separator.length);
  const localPart = `${account.localPart}${separator}${suffix.slice(0, room)}`;
  return `${localPart}@${account.domain}`;
}

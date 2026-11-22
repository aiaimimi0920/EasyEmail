import type { Env } from "./contracts";
import { HttpError } from "./http";
import type { MailCredential } from "./providers/contracts";

interface Keyring { active: string; keys: Record<string, string> }
interface VaultContext { id: string; user_id: string; provider_id: string; purpose?: string }
const encoder = new TextEncoder();

function keyring(env: Env): Keyring {
  try {
    const ring: Keyring = JSON.parse(env.MAILBOX_KEYRING ?? "{}");
    if (typeof ring.active !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(ring.active)
      || !ring.keys || typeof ring.keys !== "object" || Array.isArray(ring.keys)
      || !Object.hasOwn(ring.keys, ring.active)) throw new Error();
    for (const [id, key] of Object.entries(ring.keys)) {
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || !/^[0-9a-f]{64}$/.test(key)) throw new Error();
    }
    return ring;
  } catch { throw new HttpError(503, "mailbox_vault_unavailable"); }
}

async function importKey(hex: string): Promise<CryptoKey> {
  const bytes = Uint8Array.from(hex.match(/../g)!, (value) => Number.parseInt(value, 16));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function aad(context: VaultContext): Uint8Array {
  return encoder.encode(JSON.stringify([context.purpose ?? "ee-mailbox-v1", context.id, context.user_id, context.provider_id]));
}

export function assertVault(env: Env): void { keyring(env); }

export async function sealVault(env: Env, context: VaultContext, credential: unknown): Promise<string> {
  const ring = keyring(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(context) },
    await importKey(ring.keys[ring.active]), encoder.encode(JSON.stringify(credential)));
  return JSON.stringify({ v: 1, key: ring.active, iv: Array.from(iv), cipher: Array.from(new Uint8Array(cipher)) });
}

export async function openVault<T>(env: Env, context: VaultContext, sealed: string | null): Promise<T> {
  const ring = keyring(env);
  try {
    const payload = JSON.parse(sealed ?? "null");
    if (!payload || payload.v !== 1 || !ring.keys[payload.key]) throw new Error();
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(payload.iv), additionalData: aad(context) },
      await importKey(ring.keys[payload.key]), new Uint8Array(payload.cipher));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { throw new HttpError(503, "mailbox_credential_unavailable"); }
}

export const encryptCredential = (env: Env, context: VaultContext, credential: MailCredential) => sealVault(env, context, credential);
export const decryptCredential = (env: Env, context: VaultContext, sealed: string | null) => openVault<MailCredential>(env, context, sealed);

// Keyed request digests prevent offline password guessing from idempotency receipts.
export async function credentialRequestHash(env: Env, context: VaultContext, value: string, previous?: string): Promise<string> {
  const ring = keyring(env), id = previous ? previous.split(".")[0] : ring.active;
  if (!Object.hasOwn(ring.keys, id)) throw new HttpError(503, "mailbox_vault_unavailable");
  const material = Uint8Array.from(ring.keys[id].match(/../g)!, byte => Number.parseInt(byte, 16));
  const base = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode("ee-request-v1"), info: aad(context) },
    base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return `${id}.${Array.from(signature, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

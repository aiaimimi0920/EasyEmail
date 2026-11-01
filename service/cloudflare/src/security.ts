import { scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 };
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export function randomToken(prefix: string): string {
  return prefix + hex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function tokenHash(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

export async function secretEquals(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([tokenHash(left), tokenHash(right)]);
  return timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));
}

function derive(password: string, salt: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, SCRYPT, (error, result) => error ? reject(error) : resolve(result));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomToken("").slice(0, 32);
  const hash = hex(await derive(password, salt));
  return `scrypt$16384$8$5$${salt}$${hash}`;
}

// A missing account still performs exactly one KDF with identical parameters.
const DUMMY_HASH = `scrypt$16384$8$5$${"0".repeat(32)}$${"0".repeat(64)}`;

export async function verifyPassword(password: string, record: string | undefined): Promise<boolean> {
  const valid = record !== undefined && /^scrypt\$16384\$8\$5\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(record);
  const fields = (valid ? record : DUMMY_HASH).split("$");
  const actual = hex(await derive(password, fields[4]));
  return timingSafeEqual(new TextEncoder().encode(actual), new TextEncoder().encode(fields[5])) && valid;
}

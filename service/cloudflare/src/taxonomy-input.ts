import { HttpError } from "./http";

export const TAXONOMY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TAXONOMY_COLORS = ["blue", "green", "orange", "purple", "gray"] as const;

export function taxonomyRevision(value: unknown, code: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) >= Number.MAX_SAFE_INTEGER) throw new HttpError(400, code);
  return value as number;
}

export function taxonomyFields(body: Record<string, unknown>, code: string) {
  if (typeof body.name !== "string" || body.name.length > 160 || /[\p{Cc}\p{Cf}]/u.test(body.name)
    || typeof body.color !== "string" || !(TAXONOMY_COLORS as readonly string[]).includes(body.color)) throw new HttpError(400, code);
  const name = body.name.normalize("NFC").trim();
  if (!name || [...name].length > 40) throw new HttpError(400, code);
  return { name, nameKey: name.toLowerCase(), color: body.color, expectedRevision: taxonomyRevision(body.expectedRevision, code) };
}

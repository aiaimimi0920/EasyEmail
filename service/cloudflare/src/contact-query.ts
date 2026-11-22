import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { tokenHash } from "./security";
import { CONTACT_UUID } from "./contact-input";
import { contactView, type ContactRow } from "./contact-model";

interface Position { name: string; email: string; id: string; filter: string }
const encode = (position: Position) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(position))))
  .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function decode(raw: string, filter: string): Position | null {
  if (!raw) return null;
  try {
    if (raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw Error();
    const bytes = Uint8Array.from(atob(raw.replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!value || Object.keys(value).sort().join(",") !== "email,filter,id,name" || typeof value.name !== "string" || value.name.length > 320
      || typeof value.email !== "string" || value.email.length > 254 || !CONTACT_UUID.test(value.id) || value.filter !== filter) throw Error();
    return value;
  } catch { throw new HttpError(400, "invalid_cursor"); }
}

export async function listContacts(url: URL, env: Env, identity: Identity) {
  const params = url.searchParams;
  for (const key of params.keys()) if (!["q", "limit", "cursor"].includes(key) || params.getAll(key).length !== 1) throw new HttpError(400, "invalid_filter");
  const limit = params.get("limit") ?? "50", q = (params.get("q") ?? "").normalize("NFC").trim();
  if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) throw new HttpError(400, "invalid_limit");
  if (q.length > 320 || [...q].length > 80 || /[\p{Cc}\p{Cf}]/u.test(q)) throw new HttpError(400, "invalid_filter");
  const filter = await tokenHash(JSON.stringify([identity.userId, q])), after = decode(params.get("cursor") ?? "", filter);
  const { results } = await env.DB.prepare(`SELECT * FROM contacts WHERE user_id=? AND deleted_at IS NULL
    AND (instr(lower(display_name),lower(?))>0 OR instr(email_address,lower(?))>0)
    ${after ? "AND (name_key>? OR (name_key=? AND email_address>?) OR (name_key=? AND email_address=? AND id>?))" : ""}
    ORDER BY name_key,email_address,id LIMIT ?`).bind(identity.userId, q, q,
      ...(after ? [after.name, after.name, after.email, after.name, after.email, after.id] : []), Number(limit) + 1).all<ContactRow>();
  const rows = results.slice(0, Number(limit)), last = rows.at(-1);
  return { items: rows.map(contactView), nextCursor: results.length > Number(limit) && last
    ? encode({ name: last.name_key, email: last.email_address, id: last.id, filter }) : null };
}

import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { tokenHash } from "./security";
import { validServiceKind } from "./agent-service-input";
import { AGENT_SERVICE_STATUSES, AGENT_TRUST_LEVELS, AGENT_SERVICE_UUID, AGENT_SERVICE_SELECT, agentServiceView, type AgentServiceRow } from "./agent-service-model";

interface Cursor { id: string; filter: string }
function decodeCursor(raw: string, filter: string): string {
  if (!raw) return "";
  try {
    if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw Error();
    const bytes = Uint8Array.from(atob(raw.replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0));
    const value: Cursor = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!value || Object.keys(value).sort().join(",") !== "filter,id" || !AGENT_SERVICE_UUID.test(value.id) || value.filter !== filter) throw Error();
    return value.id;
  } catch { throw new HttpError(400, "invalid_cursor"); }
}

export async function listAgentServices(url: URL, env: Env, identity: Identity) {
  const params = url.searchParams;
  for (const key of params.keys()) if (!["q", "status", "trustLevel", "serviceKind", "limit", "cursor"].includes(key)
    || params.getAll(key).length !== 1) throw new HttpError(400, "invalid_filter");
  const limit = params.get("limit") ?? "25", q = (params.get("q") ?? "").normalize("NFC").trim();
  if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) throw new HttpError(400, "invalid_limit");
  if (q.length > 320 || [...q].length > 80 || /[\p{Cc}\p{Cf}]/u.test(q)) throw new HttpError(400, "invalid_filter");
  const status = params.get("status"), trust = params.get("trustLevel"), kind = params.get("serviceKind");
  if (status !== null && !(AGENT_SERVICE_STATUSES as readonly string[]).includes(status)
    || trust !== null && !(AGENT_TRUST_LEVELS as readonly string[]).includes(trust)
    || kind !== null && !validServiceKind(kind)) throw new HttpError(400, "invalid_filter");
  const filter = await tokenHash(JSON.stringify([identity.userId, q, status, trust, kind]));
  const after = decodeCursor(params.get("cursor") ?? "", filter);
  const { results } = await env.DB.prepare(`${AGENT_SERVICE_SELECT} WHERE user_id=? AND deleted_at IS NULL AND id>?
    AND (instr(lower(display_name),lower(?))>0 OR instr(email_address,lower(?))>0)
    ${status !== null ? "AND status=?" : ""} ${trust !== null ? "AND trust_level=?" : ""} ${kind !== null ? "AND service_kind=?" : ""}
    ORDER BY id LIMIT ?`).bind(identity.userId, after, q, q, ...(status !== null ? [status] : []), ...(trust !== null ? [trust] : []),
      ...(kind !== null ? [kind] : []), Number(limit) + 1).all<AgentServiceRow>();
  const rows = results.slice(0, Number(limit)), last = rows.at(-1);
  return { items: rows.map(agentServiceView), nextCursor: results.length > Number(limit) && last
    ? btoa(JSON.stringify({ id: last.id, filter })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") : null };
}

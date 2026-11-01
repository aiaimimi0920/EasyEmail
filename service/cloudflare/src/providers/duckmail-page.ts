import { HttpError } from "../http";
import { object, string } from "./http";

function pointer(value: unknown, base: string, route: string, expected: number): void {
  const raw = string(value, 2048);
  let url: URL;
  try { url = new URL(raw, `${base}/`); }
  catch { throw new HttpError(502, "provider_invalid_response"); }
  const endpoint = new URL(`${base}${route}`), keys = [...url.searchParams.keys()];
  if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname || url.username || url.password || url.hash
    || keys.length > 1 || keys.some(key => key !== "page")
    || (url.searchParams.get("page") ?? "1") !== String(expected)) throw new HttpError(502, "provider_invalid_response");
}

export function duckmailPage(value: unknown, base: string, route: string, page: number, maxTotal: number) {
  const data = object(value), rows = data["hydra:member"], total = data["hydra:totalItems"];
  if (!Array.isArray(rows) || !Number.isSafeInteger(total) || (total as number) < 0 || (total as number) > maxTotal) {
    throw new HttpError(502, "provider_invalid_response");
  }
  const last = Math.max(1, Math.ceil((total as number) / 30));
  if (page > last || rows.length !== Math.min(30, Math.max(0, (total as number) - (page - 1) * 30))) throw new HttpError(502, "provider_invalid_response");
  const view = object(data["hydra:view"]);
  pointer(view["hydra:first"], base, route, 1); pointer(view["hydra:last"], base, route, last);
  if (view["@id"] !== undefined) pointer(view["@id"], base, route, page);
  if (view["hydra:next"] != null) {
    if (page >= last) throw new HttpError(502, "provider_invalid_response");
    pointer(view["hydra:next"], base, route, page + 1);
  }
  return { rows: rows.map(object), total: total as number, nextPage: page < last ? page + 1 : null };
}

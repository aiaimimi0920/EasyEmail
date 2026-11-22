import { unixNow } from "./contracts";
import { HttpError } from "./http";

// Undefined preserves older providers' policy-only behavior; explicit null means no upstream deadline.
export function creationExpiry(local: number | null, remote?: number | null): number | null {
  if (remote === undefined || remote === null) return local;
  if (!Number.isSafeInteger(remote) || remote <= unixNow() || remote > 253402300799) throw new HttpError(502, "provider_invalid_response");
  return Math.min(local ?? Infinity, remote);
}

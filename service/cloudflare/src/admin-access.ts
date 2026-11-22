import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { requireSession } from "./identity";

export const ADMIN_EXISTS = "EXISTS (SELECT 1 FROM platform_admins a JOIN users u ON u.id = a.user_id WHERE a.user_id = ? AND u.status = 'active')";

export async function isAdministrator(env: Env, identity: Identity): Promise<boolean> {
  if (identity.kind !== "session") return false;
  return !!await env.DB.prepare(`SELECT 1 WHERE ${ADMIN_EXISTS}`).bind(identity.userId).first();
}

export async function requireAdministrator(request: Request, env: Env, identity: Identity): Promise<void> {
  requireSession(identity, request, env);
  if (!await isAdministrator(env, identity)) throw new HttpError(403, "administrator_required");
}

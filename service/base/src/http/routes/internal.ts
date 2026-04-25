import { EASY_EMAIL_HTTP_ROUTES } from "../contracts.js";
import type { EasyEmailHttpHandler } from "../handler.js";

export interface InternalRouteContext {
  method: string;
  path: string;
  handler: EasyEmailHttpHandler;
}

export async function handleInternalRoute(context: InternalRouteContext): Promise<unknown | undefined> {
  const { method, path, handler } = context;

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.runMaintenance) {
    return handler.runMaintenance();
  }

  return undefined;
}

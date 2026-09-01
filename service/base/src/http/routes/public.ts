import { EASY_EMAIL_HTTP_ROUTES } from "../contracts.js";
import type { EasyEmailHttpHandler } from "../handler.js";

export interface PublicRouteContext {
  method: string;
  path: string;
  handler: EasyEmailHttpHandler;
  readJsonBody<T>(): Promise<T>;
  extractVerificationCodeSessionId(path: string): string | undefined;
  extractAuthenticationLinkSessionId(path: string): string | undefined;
  extractMailboxRefreshSessionId(path: string): string | undefined;
}

export async function handlePublicRoute(context: PublicRouteContext): Promise<unknown | undefined> {
  const {
    method,
    path,
    handler,
    readJsonBody,
    extractVerificationCodeSessionId,
    extractAuthenticationLinkSessionId,
    extractMailboxRefreshSessionId,
  } = context;

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.catalog) {
    return handler.getCatalog();
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.snapshot) {
    return handler.getSnapshot();
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.planMailbox) {
    return handler.planMailbox(await readJsonBody());
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.openMailbox) {
    return handler.openMailbox(await readJsonBody());
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.refreshAnonymousMailboxes) {
    return handler.refreshAnonymousMailboxes(await readJsonBody());
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.sendMailboxMessage) {
    return handler.sendMailboxMessage(await readJsonBody());
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.updateMailboxSession) {
    return handler.updateMailboxSession(await readJsonBody());
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.releaseMailbox) {
    return handler.releaseMailbox(await readJsonBody());
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.recoverMailboxByEmail) {
    return handler.recoverMailboxByEmail(await readJsonBody());
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.recoverMailboxCapacity) {
    return handler.recoverMailboxCapacity(await readJsonBody());
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.cleanupMoemailMailboxes) {
    return handler.cleanupMoemailMailboxes(await readJsonBody());
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.reportMailboxOutcome) {
    return handler.reportMailboxOutcome(await readJsonBody());
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.observeMessage) {
    return handler.observeMessage(await readJsonBody());
  }

  const mailboxRefreshSessionId = extractMailboxRefreshSessionId(path);
  if (method === "POST" && mailboxRefreshSessionId) {
    return handler.refreshMailbox(mailboxRefreshSessionId);
  }

  const verificationCodeSessionId = extractVerificationCodeSessionId(path);
  if (method === "GET" && verificationCodeSessionId) {
    return handler.readVerificationCode(verificationCodeSessionId);
  }

  const authenticationLinkSessionId = extractAuthenticationLinkSessionId(path);
  if (method === "GET" && authenticationLinkSessionId) {
    return handler.readAuthenticationLink(authenticationLinkSessionId);
  }

  return undefined;
}

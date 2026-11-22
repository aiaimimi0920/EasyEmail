import { createKey, listKeys, revokeKey } from "./api-keys";
import { logout, signIn } from "./auth";
import type { Env } from "./contracts";
import { HttpError, json, secured } from "./http";
import { authenticate } from "./identity";
import { getMailbox, listMailboxes } from "./mailbox-queries";
import { isMailPath, mailRoute } from "./mail-routes";
import { rateLimit } from "./rate-limits";
import { patchMailbox } from "./organization";
import { isAdministrator } from "./admin-access";
import { adminRoute, isAdminPath } from "./admin-routes";
import { changePassword } from "./account-password";
import { draftRoute, isDraftPath } from "./draft-routes";
import { isOrganizationPath, organizationRoute } from "./organization-routes";
import { contactRoute, isContactPath } from "./contact-routes";
import { conversationRoute, isConversationPath } from "./conversation-routes";
import { subscriptionRoute, isSubscriptionPath } from "./subscription-routes";
import { outboxRoute, isOutboxPath } from "./outbox-routes";
import { isSendJobPath, sendJobRoute } from "./send-job-routes";
import { runSendJobs } from "./send-job-runner";
import { isNormalAccountPath, normalAccountRoute } from "./normal-account-routes";
import { isNormalSendPath, normalSendRoute } from "./normal-send-routes";
import { isNormalSendJobPath, normalSendJobRoute } from "./normal-send-job-routes";
import { googleCallback, googleOAuthRoute, isGoogleOAuthPath } from "./google-oauth-routes";
import { agentServiceRoute, isAgentServicePath } from "./agent-service-routes";
import { agentAccountRoute, isAgentAccountPath } from "./agent-account-routes";
import { agentSmtpRoute, isAgentSmtpPath } from "./agent-smtp-routes";
import { agentTaskRoute, isAgentTaskPath } from "./agent-task-routes";
import { runAgentTasks } from "./agent-task-runner";
import { agentInboxRoute, isAgentInboxPath } from "./agent-inbox-routes";
import { agentReviewRoute, isAgentReviewPath } from "./agent-review-routes";
import { agentThreadRoute, isAgentThreadPath } from "./agent-thread-routes";
import { agentInboundRoute, isAgentInboundPath } from "./agent-inbound-routes";
import { agentFollowupRoute, isAgentFollowupPath } from "./agent-followup-routes";
import { runAgentFollowups } from "./agent-followup-runner";
import { autoInboxRoute, isAutoInboxPath } from "./agent-auto-inbox-routes";
import { runAgentAutoInbox } from "./agent-auto-inbox-runner";
import { runScheduledMaintenance } from "./scheduled-maintenance";

async function route(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/healthz" && request.method === "GET") return json({ service: "easyemail-cloudflare", status: "alive" });
  if (path === "/oauth/google/callback") return googleCallback(request, env);
  if (path === "/" || path.startsWith("/assets/")) {
    if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "method_not_allowed");
    const asset = await env.ASSETS.fetch(request);
    return new Response(asset.body, asset);
  }
  if (path === "/api/v1/auth/register" || path === "/api/v1/auth/login") {
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
    return signIn(request, env, path.endsWith("/register"));
  }
  const known = ["/api/v1/me", "/api/v1/auth/logout", "/api/v1/account/password", "/api/v1/api-keys", "/api/v1/mailboxes"];
  const keyMatch = /^\/api\/v1\/api-keys\/([0-9a-f-]{36})$/.exec(path);
  const mailboxMatch = /^\/api\/v1\/mailboxes\/([0-9a-f-]{36})$/.exec(path);
  if (!known.includes(path) && !keyMatch && !mailboxMatch && !isMailPath(path) && !isAdminPath(path) && !isDraftPath(path) && !isOrganizationPath(path) && !isContactPath(path) && !isConversationPath(path) && !isSubscriptionPath(path) && !isOutboxPath(path) && !isSendJobPath(path) && !isNormalAccountPath(path) && !isNormalSendPath(path) && !isNormalSendJobPath(path) && !isGoogleOAuthPath(path) && !isAgentServicePath(path) && !isAgentAccountPath(path) && !isAgentSmtpPath(path) && !isAgentTaskPath(path) && !isAgentInboxPath(path) && !isAgentReviewPath(path) && !isAgentThreadPath(path) && !isAgentInboundPath(path) && !isAgentFollowupPath(path) && !isAutoInboxPath(path)) throw new HttpError(404, "not_found");
  const identity = await authenticate(request, env);
  await rateLimit(env, "api-user", identity.userId, 120);
  if (isAutoInboxPath(path)) return autoInboxRoute(request, env, identity);
  if (isAgentFollowupPath(path)) return agentFollowupRoute(request, env, identity);
  if (isAgentInboundPath(path)) return agentInboundRoute(request, env, identity);
  if (isAgentThreadPath(path)) return agentThreadRoute(request, env, identity);
  if (isAgentReviewPath(path)) return agentReviewRoute(request, env, identity);
  if (isAgentInboxPath(path)) return agentInboxRoute(request, env, identity);
  if (isAgentTaskPath(path)) return agentTaskRoute(request, env, identity);
  if (isAgentSmtpPath(path)) return agentSmtpRoute(request, env, identity);
  if (isAgentAccountPath(path)) return agentAccountRoute(request, env, identity);
  if (isAgentServicePath(path)) return agentServiceRoute(request, env, identity);
  if (isGoogleOAuthPath(path)) return googleOAuthRoute(request, env, identity);
  if (isNormalSendJobPath(path)) return normalSendJobRoute(request, env, identity);
  if (isNormalSendPath(path)) return normalSendRoute(request, env, identity);
  if (isNormalAccountPath(path)) return normalAccountRoute(request, env, identity);
  if (isSendJobPath(path)) return sendJobRoute(request, env, identity);
  if (isOutboxPath(path)) return outboxRoute(request, env, identity);
  if (isAdminPath(path)) return adminRoute(request, env, identity);
  if (isDraftPath(path)) return draftRoute(request, env, identity);
  if (isOrganizationPath(path)) return organizationRoute(request, env, identity);
  if (isContactPath(path)) return contactRoute(request, env, identity);
  if (isConversationPath(path)) return conversationRoute(request, env, identity);
  if (isSubscriptionPath(path)) return subscriptionRoute(request, env, identity);
  if (path === "/api/v1/me" && request.method === "GET") {
    return json({ user: { id: identity.userId, username: identity.username, isAdmin: await isAdministrator(env, identity) }, credential: identity.kind });
  }
  if (path === "/api/v1/auth/logout" && request.method === "POST") return logout(request, env, identity);
  if (path === "/api/v1/account/password" && request.method === "POST") return changePassword(request, env, identity);
  if (path === "/api/v1/api-keys") {
    if (request.method === "GET") return listKeys(request, env, identity);
    if (request.method === "POST") return createKey(request, env, identity);
  }
  if (keyMatch && request.method === "DELETE") return revokeKey(request, env, identity, keyMatch[1]);
  if (path === "/api/v1/mailboxes" && request.method === "GET") return listMailboxes(request, env, identity);
  if (mailboxMatch && request.method === "GET") return getMailbox(env, identity, mailboxMatch[1]);
  if (mailboxMatch && request.method === "PATCH") return patchMailbox(request, env, identity, mailboxMatch[1]);
  if (isMailPath(path) || (path === "/api/v1/mailboxes" && request.method === "POST")) return mailRoute(request, env, identity);
  throw new HttpError(405, "method_not_allowed");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      return secured(await route(request, env), requestId);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "internal_error";
      if (status === 500) console.error(JSON.stringify({ requestId, code }));
      const response = json({ error: { code, requestId } }, status);
      if (status === 429) response.headers.set("retry-after", "60");
      if (status === 401) response.headers.set("www-authenticate", "Bearer");
      return secured(response, requestId);
    }
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === "* * * * *") {
      try { await runSendJobs(env); }
      finally { try { await runAgentTasks(env); } finally { try { await runAgentFollowups(env); } finally { await runAgentAutoInbox(env); } } }
      return;
    }
    await runScheduledMaintenance(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;

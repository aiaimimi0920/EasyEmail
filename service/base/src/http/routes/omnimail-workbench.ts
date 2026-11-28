import type { InboxRuleDefinition } from "../../domain/mail-inbox-rules.js";
import {
  EASY_EMAIL_HTTP_ROUTES,
  type AccountDiagnoseHttpRequest,
  type AnalyzeMailAiHttpRequest,
  type MuseConnectHttpRequest,
  type TranslateSegmentsHttpRequest,
  type UpdateLocalAiSettingsHttpRequest,
} from "../contracts.js";
import type { EasyEmailHttpHandler } from "../handler.js";

export interface OmnimailWorkbenchRouteContext {
  method: string;
  path: string;
  query: Record<string, string>;
  handler: EasyEmailHttpHandler;
  readJsonBody<T>(): Promise<T>;
}

export async function handleOmnimailWorkbenchRoute(
  context: OmnimailWorkbenchRouteContext,
): Promise<unknown | undefined> {
  const { method, path, query, handler, readJsonBody } = context;
  const wb = handler.omnimail;

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.providerPresets) {
    const presets = wb.listPresets();
    if (query.email?.trim()) {
      const detected = await wb.detectPreset(query.email, query.probeMx === "true");
      return { presets, detected: { preset: detected.preset, mxHosts: detected.mxExchanges } };
    }
    return { presets };
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.accountDiagnose) {
    const input = await readJsonBody<AccountDiagnoseHttpRequest>();
    return { report: await wb.diagnoseAccount(input) };
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.aiSettings) {
    return { settings: wb.ai.getPublicSettings() };
  }

  if (method === "PUT" && path === EASY_EMAIL_HTTP_ROUTES.aiSettings) {
    const body = await readJsonBody<UpdateLocalAiSettingsHttpRequest>();
    return { settings: wb.ai.updateSettings(body) };
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.aiTest) {
    return await wb.ai.testConnectivity();
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.aiTranslate) {
    const body = await readJsonBody<TranslateSegmentsHttpRequest>();
    return await wb.ai.translateSegments(body);
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.aiAnalyze) {
    const body = await readJsonBody<AnalyzeMailAiHttpRequest>();
    return { result: await wb.ai.analyzeMail(body) };
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.workbuddyAccounts) {
    return { accounts: wb.workbuddy.listAccounts() };
  }

  if (method === "DELETE" && path === EASY_EMAIL_HTTP_ROUTES.workbuddyAccounts) {
    const removed = wb.workbuddy.removeAccount(query.accountId ?? "");
    return { removed };
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.workbuddyAuthStart) {
    const body = await readJsonBody<{ baseUrl?: string }>();
    return { auth: await wb.workbuddy.startAuth(body.baseUrl) };
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.workbuddyAuthPoll) {
    const body = await readJsonBody<{ state: string }>();
    return await wb.workbuddy.pollAuth(body.state ?? "");
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.workbuddyMessages) {
    if (query.messageId?.trim()) {
      return {
        message: await wb.workbuddy.getMessageDetail(query.accountId ?? "", query.messageId),
      };
    }
    return await wb.workbuddy.listMessages(
      query.accountId ?? "",
      query.dir === "sent" ? "sent" : "inbox",
      query.q,
      query.cursor,
    );
  }

  if (method === "DELETE" && path === EASY_EMAIL_HTTP_ROUTES.workbuddyMessages) {
    return {
      result: await wb.workbuddy.deleteMessage(
        query.accountId ?? "",
        query.messageId ?? "",
        query.confirmationToken,
      ),
    };
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.museStatus) {
    return { status: wb.muse.getStatus() };
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.museSession) {
    const body = await readJsonBody<MuseConnectHttpRequest>();
    return { status: await wb.muse.connectReadOnlySession(body) };
  }

  if (method === "DELETE" && path === EASY_EMAIL_HTTP_ROUTES.museSession) {
    wb.muse.disconnectAndWipe();
    return { status: wb.muse.getStatus() };
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.museThreads) {
    if (query.threadId?.trim()) {
      const detail = await wb.muse.getThreadDetail(query.threadId.trim());
      return { email: detail.email, detail };
    }
    return await wb.muse.listThreads(query.cursor);
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.inboxRules) {
    return wb.enhancements.listRules();
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.inboxRules) {
    const body = await readJsonBody<Partial<InboxRuleDefinition> & { name: string }>();
    const saved = wb.enhancements.saveRule(body);
    return { rule: saved, ...wb.enhancements.listRules() };
  }

  if (method === "DELETE" && path === EASY_EMAIL_HTTP_ROUTES.inboxRules) {
    const deleted = wb.enhancements.deleteRule(query.id ?? "");
    return { deleted, ...wb.enhancements.listRules() };
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.inboxRulesDryRun) {
    const body = await readJsonBody<{ windowDays?: number; draftRules?: InboxRuleDefinition[] }>();
    return { report: await wb.enhancements.previewRulesDryRun(body) };
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.inboxRulesApply) {
    const body = await readJsonBody<{ windowDays?: number }>();
    return await wb.enhancements.applyRulesToExistingMessages(body.windowDays ?? 30);
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.inboxRulesBlocklist) {
    const body = await readJsonBody<{ pattern: string }>();
    return { blocklist: wb.enhancements.updateBlocklist(body.pattern ?? "", false) };
  }

  if (method === "DELETE" && path === EASY_EMAIL_HTTP_ROUTES.inboxRulesBlocklist) {
    const body = await readJsonBody<{ pattern: string }>();
    return { blocklist: wb.enhancements.updateBlocklist(body.pattern ?? "", true) };
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.contactDuplicates) {
    return { groups: await wb.enhancements.findContactDuplicates() };
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.contactMerge) {
    const body = await readJsonBody<{ primaryContactId: string; secondaryContactIds: string[] }>();
    return {
      merged: await wb.enhancements.mergeContacts(
        body.primaryContactId ?? "",
        body.secondaryContactIds ?? [],
      ),
    };
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.contactVCard) {
    return await wb.enhancements.exportContactsVCard();
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.contactVCard) {
    const body = await readJsonBody<{ vcf: string }>();
    return await wb.enhancements.importContactsVCard(body.vcf ?? "");
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.contactCandidates) {
    return { candidates: await wb.enhancements.extractContactCandidates() };
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.calendarParse) {
    const body = await readJsonBody<{ ics: string; selfEmail?: string; extraText?: string }>();
    return wb.enhancements.parseCalendarInvite(body.ics ?? "", body.selfEmail, body.extraText);
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.calendarRsvp) {
    const body = await readJsonBody<{
      ics: string;
      responderEmail: string;
      decision: "accepted" | "tentative" | "declined";
    }>();
    return wb.enhancements.recordCalendarRsvp(body);
  }

  return undefined;
}

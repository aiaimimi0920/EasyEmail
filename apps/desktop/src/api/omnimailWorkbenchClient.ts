import type { EasyEmailHttpRequest } from "./easyEmailCoreTypes.ts";

export interface OmnimailWorkbenchTransport {
  requestWorkbench<TResponse = unknown>(req: EasyEmailHttpRequest): Promise<TResponse>;
}

export interface DesktopProviderPresetDto {
  id: string;
  name: string;
  category: string;
  defaultImapHost: string;
  defaultImapPort: number;
  defaultImapSecurity: "tls" | "starttls";
  defaultSmtpHost: string;
  defaultSmtpPort: number;
  defaultSmtpSecurity: "tls" | "starttls";
  supportsAppPassword: boolean;
  guideSummary: string;
}

export interface DesktopFourStageReportDto {
  ok: boolean;
  summary: string;
  steps: Array<{ stage: string; label: string; ok: boolean; durationMs: number; detail: string; suggestion?: string }>;
}

export interface DesktopAiSettingsDto {
  enabled: boolean;
  provider: "openai" | "deepseek" | "claude" | "gemini" | "ollama" | "custom";
  endpointUrl: string;
  modelName: string;
  credentialConfigured: boolean;
  includeSubject: boolean;
  requireConsent: boolean;
  translationEnabled: boolean;
  translationProvider: "byok" | "free";
  translationTargetLang: string;
  freeTranslateAvailable: boolean;
  version: number;
}

export interface DesktopWorkBuddyAccountDto {
  id: string;
  aliasId: string;
  emailAddress: string;
  displayName: string;
  mailboxStatus: string;
  dailyQuota: { limit: number; remaining: number; reset: number; hasQuota: boolean };
}

export interface DesktopMuseStatusDto {
  loginStage: "idle" | "connected";
  bound: boolean;
  verifiedEmail: string;
  accountName: string;
  readOnly: true;
  memoryOnly: true;
  lastRefreshedAt: number;
}

export function createOmnimailWorkbenchClient(transport: OmnimailWorkbenchTransport) {
  return {
    listProviderPresets(email?: string, probeMx = false) {
      return transport.requestWorkbench<{
        presets: DesktopProviderPresetDto[];
        detected?: { preset: DesktopProviderPresetDto | null; mxHosts: string[] };
      }>({
        method: "GET",
        path: "/mail/provider-presets",
        query: email ? { email, probeMx: probeMx ? "true" : "false" } : undefined,
      });
    },
    diagnoseConnectivity(body: Record<string, unknown>) {
      return transport.requestWorkbench<{ report: DesktopFourStageReportDto }>({
        method: "POST",
        path: "/mail/accounts/diagnose",
        body,
      });
    },
    getAiSettings() {
      return transport.requestWorkbench<{ settings: DesktopAiSettingsDto }>({
        method: "GET",
        path: "/mail/ai/settings",
      });
    },
    updateAiSettings(body: Record<string, unknown>) {
      return transport.requestWorkbench<{ settings: DesktopAiSettingsDto }>({
        method: "PUT",
        path: "/mail/ai/settings",
        body,
      });
    },
    testAiModel() {
      return transport.requestWorkbench<{ ok: boolean; latencyMs: number; sample: string }>({
        method: "POST",
        path: "/mail/ai/test",
        body: {},
      });
    },
    translateSegments(body: {
      segments: string[];
      sourceLang?: string;
      targetLang?: string;
      securityLevel?: "safe" | "warning" | "danger";
    }) {
      return transport.requestWorkbench<{ sourceLanguage: string; translations: string[] }>({
        method: "POST",
        path: "/mail/ai/translate",
        body,
      });
    },
    analyzeMail(body: Record<string, unknown>) {
      return transport.requestWorkbench<{
        result: {
          kind: string;
          summaryTitle?: string;
          summary?: string;
          deadlines?: Array<{ label: string; timeText: string; urgent: boolean }>;
          draftReply?: string;
          draftTag?: string;
          polishedText?: string;
        };
      }>({
        method: "POST",
        path: "/mail/ai/analyze",
        body,
      });
    },
    listWorkBuddyAccounts() {
      return transport.requestWorkbench<{ accounts: DesktopWorkBuddyAccountDto[] }>({
        method: "GET",
        path: "/mail/agent/workbuddy/accounts",
      });
    },
    removeWorkBuddyAccount(accountId: string) {
      return transport.requestWorkbench<{ removed: boolean }>({
        method: "DELETE",
        path: "/mail/agent/workbuddy/accounts",
        query: { accountId },
      });
    },
    startWorkBuddyAuth(baseUrl?: string) {
      return transport.requestWorkbench<{ auth: { state: string; authUrl: string } }>({
        method: "POST",
        path: "/mail/agent/workbuddy/auth/start",
        body: baseUrl ? { baseUrl } : {},
      });
    },
    pollWorkBuddyAuth(state: string) {
      return transport.requestWorkbench<{ stage: string; account?: DesktopWorkBuddyAccountDto }>({
        method: "POST",
        path: "/mail/agent/workbuddy/auth/poll",
        body: { state },
      });
    },
    listWorkBuddyMessages(accountId: string, dir: "inbox" | "sent" = "inbox", q?: string) {
      return transport.requestWorkbench<{
        items: Array<{ messageId: string; subject: string; from: string; snippet: string; createdAt: string }>;
      }>({
        method: "GET",
        path: "/mail/agent/workbuddy/messages",
        query: { accountId, dir, ...(q ? { q } : {}) },
      });
    },
    getWorkBuddyMessageDetail(accountId: string, messageId: string) {
      return transport.requestWorkbench<{
        message: { messageId: string; subject: string; from: string; plainText: string; sanitizedHtml: string };
      }>({
        method: "GET",
        path: "/mail/agent/workbuddy/messages",
        query: { accountId, messageId },
      });
    },
    deleteWorkBuddyMessage(accountId: string, messageId: string, confirmationToken?: string) {
      return transport.requestWorkbench<{
        result: { needsConfirmation: boolean; confirmationToken?: string; deleted: boolean };
      }>({
        method: "DELETE",
        path: "/mail/agent/workbuddy/messages",
        query: { accountId, messageId, ...(confirmationToken ? { confirmationToken } : {}) },
      });
    },
    getMuseStatus() {
      return transport.requestWorkbench<{ status: DesktopMuseStatusDto }>({
        method: "GET",
        path: "/mail/agent/muse/status",
      });
    },
    connectMuseSession(cookieHeader: string, accountName?: string) {
      return transport.requestWorkbench<{ status: DesktopMuseStatusDto }>({
        method: "POST",
        path: "/mail/agent/muse/session",
        body: { cookieHeader, accountName },
      });
    },
    disconnectMuseSession() {
      return transport.requestWorkbench<{ status: DesktopMuseStatusDto }>({
        method: "DELETE",
        path: "/mail/agent/muse/session",
      });
    },
    listMuseThreads(threadId?: string) {
      return transport.requestWorkbench<{
        email: string;
        threads?: Array<{ id: string; subject: string; lastFrom: string; preview: string; messageCount: number }>;
        detail?: {
          id: string;
          subject: string;
          messages: Array<{ id: string; from: string; bodyText: string; museAuthVerdict?: string }>;
        };
      }>({
        method: "GET",
        path: "/mail/agent/muse/threads",
        query: threadId ? { threadId } : undefined,
      });
    },
    listRules() {
      return transport.requestWorkbench<{
        items: Array<{ id: string; name: string; priority: number }>;
        blocklist: string[];
      }>({ method: "GET", path: "/mail/rules" });
    },
    saveRule(body: Record<string, unknown>) {
      return transport.requestWorkbench<{ items: Array<{ id: string; name: string; priority: number }> }>({
        method: "POST",
        path: "/mail/rules",
        body,
      });
    },
    deleteRule(id: string) {
      return transport.requestWorkbench<{ deleted: boolean }>({
        method: "DELETE",
        path: "/mail/rules",
        query: { id },
      });
    },
    previewRulesDryRun(windowDays = 30) {
      return transport.requestWorkbench<{
        report: { windowDays: number; scannedCount: number; matchedCount: number; matches: Array<{ messageId: string; subject: string; sender: string }> };
      }>({
        method: "POST",
        path: "/mail/rules/dry-run",
        body: { windowDays },
      });
    },
    applyRules(windowDays = 30) {
      return transport.requestWorkbench<{
        appliedCount: number;
        report: { windowDays: number; scannedCount: number; matchedCount: number };
      }>({
        method: "POST",
        path: "/mail/rules/apply",
        body: { windowDays },
      });
    },
    findContactDuplicates() {
      return transport.requestWorkbench<{
        groups: Array<{ groupKey: string; canonicalKey: string; members: Array<{ id: string; displayName: string; emailAddress: string }> }>;
      }>({ method: "GET", path: "/mail/contact-tools/duplicates" });
    },
    listContactCandidates() {
      return transport.requestWorkbench<{
        candidates: Array<{ displayName: string; emailAddress: string }>;
      }>({ method: "GET", path: "/mail/contact-tools/candidates" });
    },
    mergeContacts(primaryContactId: string, secondaryContactIds: string[]) {
      return transport.requestWorkbench<{ merged: { primaryEmailAddress: string } }>({
        method: "POST",
        path: "/mail/contact-tools/merge",
        body: { primaryContactId, secondaryContactIds },
      });
    },
    exportVCard() {
      return transport.requestWorkbench<{ vcf: string; count: number }>({
        method: "GET",
        path: "/mail/contact-tools/vcard",
      });
    },
    importVCard(vcf: string) {
      return transport.requestWorkbench<{ importedCount: number }>({
        method: "POST",
        path: "/mail/contact-tools/vcard",
        body: { vcf },
      });
    },
    parseCalendarIcs(ics: string, selfEmail?: string) {
      return transport.requestWorkbench<{
        invite: { uid: string; title: string; location: string; meetingUrl?: string; startAtMs: number; endAtMs: number; selfStatus: string };
        conflict: { hasConflict: boolean; conflictingTitle?: string };
      }>({
        method: "POST",
        path: "/mail/calendar/parse",
        body: { ics, selfEmail },
      });
    },
    recordCalendarRsvp(ics: string, responderEmail: string, decision: "accepted" | "tentative" | "declined") {
      return transport.requestWorkbench<{
        savedStatus: string;
        organizerEmail: string;
        replyDraft: { subject: string; bodyText: string; icsContent: string };
      }>({
        method: "POST",
        path: "/mail/calendar/rsvp",
        body: { ics, responderEmail, decision },
      });
    },
  };
}

export type OmnimailWorkbenchClient = ReturnType<typeof createOmnimailWorkbenchClient>;

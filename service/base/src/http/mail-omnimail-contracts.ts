import type {
  MailFourStageProbeReport,
  MailProviderPreset,
} from "../domain/mail-provider-presets.js";
import type { InboxRuleDefinition, InboxRuleDryRunReport } from "../domain/mail-inbox-rules.js";
import type { ContactDuplicateGroup, ContactMergePlan } from "../domain/mail-contact-tools.js";
import type { CalendarConflictCheck, CalendarRsvpStatus, ParsedCalendarInvite } from "../domain/mail-ics-calendar.js";
import type { LocalAiProviderKind, LocalAiSettingsPublic } from "../service/mail-ai-gateway.js";
import type { AdHocAccountDiagnoseInput } from "../service/omnimail-workbench-facade.js";
import type { LocalWorkBuddyAccountPublic } from "../service/workbuddy-agent-service.js";
import type { MuseMailStatusDto, MuseMessageDto, MuseThreadSummaryDto } from "../service/muse-mail/muse-readonly-service.js";

export interface ProviderPresetsHttpResponse {
  presets: readonly MailProviderPreset[];
  detected?: {
    preset: MailProviderPreset | null;
    mxHosts: string[];
  };
}

export type AccountDiagnoseHttpRequest = AdHocAccountDiagnoseInput;
export interface AccountDiagnoseHttpResponse {
  report: MailFourStageProbeReport;
}

export interface UpdateLocalAiSettingsHttpRequest {
  enabled?: boolean;
  provider?: LocalAiProviderKind;
  endpointUrl?: string;
  modelName?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  includeSubject?: boolean;
  requireConsent?: boolean;
  translationEnabled?: boolean;
  translationProvider?: "byok" | "free";
  translationTargetLang?: string;
}

export interface LocalAiSettingsHttpResponse {
  settings: LocalAiSettingsPublic;
}

export interface TranslateSegmentsHttpRequest {
  segments: string[];
  sourceLang?: string;
  targetLang?: string;
  folder?: string;
  securityLevel?: "safe" | "warning" | "danger";
}

export interface AnalyzeMailAiHttpRequest {
  task: "preview" | "summary" | "draft" | "polish";
  subject?: string;
  text?: string;
  html?: string;
  folder?: string;
  securityLevel?: "safe" | "warning" | "danger";
  tone?: "formal" | "friendly";
  consentConfirmed?: boolean;
}

export interface WorkBuddyAccountsHttpResponse {
  accounts: LocalWorkBuddyAccountPublic[];
}

export interface MuseConnectHttpRequest {
  cookieHeader: string;
  accountName?: string;
  museOrigin?: string;
  gatewayUrl?: string;
}

export interface MuseStatusHttpResponse {
  status: MuseMailStatusDto;
}

export interface MuseThreadsHttpResponse {
  email: string;
  threads?: MuseThreadSummaryDto[];
  nextCursor?: string;
  detail?: {
    id: string;
    subject: string;
    email: string;
    messages: MuseMessageDto[];
  };
}

export interface InboxRulesHttpResponse {
  items: InboxRuleDefinition[];
  blocklist: string[];
}

export interface InboxRulesDryRunHttpResponse {
  report: InboxRuleDryRunReport;
}

export interface InboxRulesApplyHttpResponse {
  appliedCount: number;
  report: InboxRuleDryRunReport;
}

export interface ContactDuplicatesHttpResponse {
  groups: ContactDuplicateGroup[];
}

export interface ContactCandidatesHttpResponse {
  candidates: Array<{ displayName: string; emailAddress: string }>;
}

export interface ContactMergeHttpResponse {
  merged: ContactMergePlan;
}

export interface CalendarParseHttpResponse {
  invite: ParsedCalendarInvite;
  conflict: CalendarConflictCheck;
}

export interface CalendarRsvpHttpResponse {
  savedStatus: CalendarRsvpStatus;
  organizerEmail: string;
  replyDraft: { icsContent: string; subject: string; bodyText: string };
}

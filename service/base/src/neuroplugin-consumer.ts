export type {
  BindingMode,
  MailBusinessStrategyId,
  MailProviderGroupKey,
  MailProviderTypeKey,
  MailboxOutcomeReport,
  MailboxOutcomeReportResult,
  MailboxPlanResult,
  ProvisionMode,
  VerificationCodeResult,
  VerificationMailboxOpenResult,
  VerificationMailboxRequest,
} from "./domain/models.js";
export { normalizeMailProviderTypeKey } from "./domain/models.js";
export {
  parseMailStrategyModeJson,
  resolveMailStrategyMode,
} from "./domain/strategy-mode.js";
export type {
  FetchJsonHttpClientOptions,
  JsonHttpClient,
  VerificationInboxClient,
} from "./consumer/http-client.js";
export {
  createFetchJsonHttpClient,
  HttpVerificationInboxClient,
} from "./consumer/http-client.js";

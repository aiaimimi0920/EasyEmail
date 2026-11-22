export {
  createInlineCredentialSet,
  resolveIm215Config,
  resolveIm215CredentialSets,
  type Im215Config,
} from "./protocol-config.js";
export {
  buildIm215StatusError,
  classifyIm215Error,
  classifyThrownError,
  Im215ClientError,
  isSharedDomainRestrictionMessage,
  parseExactEmailAddress,
} from "./protocol-errors.js";
export { requestJson } from "./protocol-http.js";
export {
  extractDomainCandidates,
  extractMailboxPayload,
  extractMessageList,
  readMessageHtml,
  readMessageId,
  readMessageSender,
  readMessageSubject,
  readMessageText,
  readObservedAt,
  type Im215MailboxRefPayload,
} from "./protocol-payload.js";
export {
  asRecord,
  asRecordList,
  createRandomSuffix,
  encodeQuery,
  extractOtp,
  isDisabledFlag,
  isIm215DomainUsable,
  matchesSenderFilter,
  nextDomainRotationOffset,
  normalizeDomain,
  normalizeFilter,
  parseOptionalInteger,
  readMetadata,
  readSender,
  readString,
  sanitizeLocalPart,
} from "./protocol-values.js";

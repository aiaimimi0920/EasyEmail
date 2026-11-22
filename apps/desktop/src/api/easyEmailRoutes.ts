import type { EasyEmailMailTaxonomyKind } from "./easyEmailMailTypes.ts";

export const EASY_EMAIL_CORE_ROUTES = {
  catalog: "/mail/catalog",
  planMailbox: "/mail/mailboxes/plan",
  openMailbox: "/mail/mailboxes/open",
  refreshAnonymousMailboxes: "/mail/mailboxes/anonymous/refresh",
  queryProviderInstances: "/mail/query/provider-instances",
  queryMailboxSessions: "/mail/query/mailbox-sessions",
  queryObservedMessages: "/mail/query/observed-messages",
  updateMailbox: "/mail/mailboxes/update-session",
  releaseMailbox: "/mail/mailboxes/release",
  recoverMailbox: "/mail/mailboxes/recover-by-email",
  reportMailboxOutcome: "/mail/mailboxes/report-outcome",
  sendMailboxMessage: "/mail/mailboxes/send",
  contacts: "/mail/contacts",
  taxonomy: "/mail/taxonomy",
  accounts: "/mail/accounts",
  testAccountImap: "/mail/accounts/imap/test",
  drafts: "/mail/drafts",
  messages: "/mail/messages",
  trash: "/mail/trash",
  verifications: "/mail/verifications",
  verificationCode(sessionId: string): string {
    return `/mail/mailboxes/${encodeURIComponent(sessionId)}/code`;
  },
  authenticationLink(sessionId: string): string {
    return `/mail/mailboxes/${encodeURIComponent(sessionId)}/auth-link`;
  },
  refreshMailbox(sessionId: string): string {
    return `/mail/mailboxes/${encodeURIComponent(sessionId)}/refresh`;
  },
  observedMessage(messageId: string): string {
    return `/mail/query/observed-messages/${encodeURIComponent(messageId)}`;
  },
  contact(contactId: string): string {
    return `/mail/contacts/${encodeURIComponent(contactId)}`;
  },
  taxonomyItem(itemId: string): string {
    return `/mail/taxonomy/${encodeURIComponent(itemId)}`;
  },
  taxonomyUpsert(kind: EasyEmailMailTaxonomyKind, key: string): string {
    return `/mail/taxonomy/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`;
  },
  account(accountId: string): string {
    return `/mail/accounts/${encodeURIComponent(accountId)}`;
  },
  disableAccount(accountId: string): string {
    return `/mail/accounts/${encodeURIComponent(accountId)}/disable`;
  },
  draft(messageId: string): string {
    return `/mail/drafts/${encodeURIComponent(messageId)}`;
  },
  message(messageId: string): string {
    return `/mail/messages/${encodeURIComponent(messageId)}`;
  },
  messageLocal(messageId: string): string {
    return `/mail/messages/${encodeURIComponent(messageId)}/local`;
  },
  messageFlags(messageId: string): string {
    return `/mail/messages/${encodeURIComponent(messageId)}/flags`;
  },
  messageFolder(messageId: string): string {
    return `/mail/messages/${encodeURIComponent(messageId)}/folder`;
  },
  messageLabels(messageId: string): string {
    return `/mail/messages/${encodeURIComponent(messageId)}/labels`;
  },
  reclassifyMessageVerification(messageId: string): string {
    return `/mail/messages/${encodeURIComponent(messageId)}/reclassify-verification`;
  },
  pollMailboxVerification(sessionId: string): string {
    return `/mail/mailboxes/${encodeURIComponent(sessionId)}/verification/poll`;
  },
} as const;

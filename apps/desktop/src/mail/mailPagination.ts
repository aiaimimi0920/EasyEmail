type ConversationLike = { messages: unknown[] };

export type PaginatedConversations<TConversation extends ConversationLike> = {
  mailListTotalPages: number;
  clampedMailListCurrentPage: number;
  mailListPageStart: number;
  mailListPageEnd: number;
  paginatedDisplayedMailConversations: TConversation[];
  paginatedDisplayedMailMessages: TConversation["messages"][number][];
};

/**
 * Slices grouped conversations into the active page.
 *
 * Kept as a pure function so paging does not depend on the filter/sort/group
 * pipeline that produces `conversations`: turning a page only re-runs this.
 *
 * `requestedPage` is clamped rather than rejected, because the conversation list
 * shrinks underneath the stored page index whenever a filter narrows results.
 */
export function paginateMailConversations<TConversation extends ConversationLike>(
  conversations: TConversation[],
  requestedPage: number,
  pageSize: number,
): PaginatedConversations<TConversation> {
  const mailListTotalPages = Math.max(1, Math.ceil(conversations.length / pageSize));
  const clampedMailListCurrentPage = Math.min(requestedPage, mailListTotalPages - 1);
  const mailListPageStart =
    conversations.length === 0 ? 0 : clampedMailListCurrentPage * pageSize;
  const mailListPageEnd = Math.min(conversations.length, mailListPageStart + pageSize);
  const paginatedDisplayedMailConversations = conversations.slice(
    mailListPageStart,
    mailListPageEnd,
  );
  const paginatedDisplayedMailMessages = paginatedDisplayedMailConversations.flatMap(
    (conversation) => conversation.messages,
  );

  return {
    mailListTotalPages,
    clampedMailListCurrentPage,
    mailListPageStart,
    mailListPageEnd,
    paginatedDisplayedMailConversations,
    paginatedDisplayedMailMessages,
  };
}

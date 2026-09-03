import type { AppController } from "../../app/useAppController";

export function MailListPane({ controller }: { controller: AppController }) {
  const {
    mailboxView, displayedNewsletterSubscriptions, hiddenNewsletterSubscriptionCount, setShowHiddenNewsletterSubscriptions, showHiddenNewsletterSubscriptions, selectedNewsletterSubscription, setSelectedNewsletterSubscription, selectNewsletterSubscription,
    handleNewsletterSubscriptionHidden, handleNewsletterUnsubscribe, onlyCodes, paginatedCodeBackedMailMessages, selectedMailMessageId, selectedMailMessageIdsSet, toggleMailMessageSelection, copyVerificationCode,
    SenderAvatarIcon, senderAvatarFor, openAvatarEditor, openMailMessage, formatMailListTime, renderMailListStateRow, codeBackedMailMessages, visibleMailMessages,
    displayedMailConversations, paginatedDisplayedMailConversations, MailConversationCard, selectedMailConversation, onCardOpen, onCardToggleSelected, onCardAvatarClick, selectedMailboxLabel,
  } = controller;
  return (
    <section className="nt-list-pane">
      {mailboxView === "newsletters" ? (
        <section
          className="nt-newsletter-subscriptions"
      aria-label="订阅邮件管理"
        >
          <div className="nt-newsletter-subscriptions__head">
        <strong>订阅管理</strong>
            <span>
              {displayedNewsletterSubscriptions.length}
              {hiddenNewsletterSubscriptionCount > 0
                ? ` / ${hiddenNewsletterSubscriptionCount} hidden`
                : ""}
            </span>
          </div>
          {hiddenNewsletterSubscriptionCount > 0 ? (
            <button
              type="button"
              className="nt-newsletter-subscriptions__toggle"
              onClick={() =>
                setShowHiddenNewsletterSubscriptions((current) => !current)
              }
            >
              {showHiddenNewsletterSubscriptions ? "Hide hidden subscriptions" : "Show hidden subscriptions"}
            </button>
          ) : null}
          {selectedNewsletterSubscription ? (
            <button
              type="button"
              className="nt-newsletter-subscriptions__filter"
              onClick={() => setSelectedNewsletterSubscription(null)}
            >
              Clear subscription filter
            </button>
          ) : null}
          {displayedNewsletterSubscriptions.length > 0 ? (
            <div className="nt-newsletter-subscriptions__grid">
              {displayedNewsletterSubscriptions.slice(0, 6).map((subscription) => (
                <article
                  key={`${subscription.account_id}:${subscription.id}`}
                  className={`nt-newsletter-subscription-card ${
                    subscription.spam ? "nt-newsletter-subscription-card--spam" : ""
                  } ${
                    subscription.hidden ? "nt-newsletter-subscription-card--hidden" : ""
                  } ${
                    selectedNewsletterSubscription?.accountId === subscription.account_id &&
                    selectedNewsletterSubscription.subscriptionId === subscription.id
                      ? "nt-newsletter-subscription-card--active"
                      : ""
                  }`}
                >
                  <button
                    type="button"
                    className="nt-newsletter-subscription-card__open"
                    aria-pressed={
                      selectedNewsletterSubscription?.accountId ===
                        subscription.account_id &&
                      selectedNewsletterSubscription.subscriptionId === subscription.id
                    }
                    onClick={() => selectNewsletterSubscription(subscription)}
                  >
                    <strong>{subscription.name}</strong>
                    <span>{subscription.sender_address}</span>
                    <small>
                      {subscription.received_message_count} messages ·{" "}
                      {subscription.unread_message_count} unread
                    </small>
                    {subscription.unsubscribe_methods.length > 0 ? (
                      <em>可取消订阅</em>
                    ) : null}
                  </button>
                  <div className="nt-newsletter-subscription-card__actions">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleNewsletterSubscriptionHidden(
                          subscription,
                          !subscription.hidden,
                        );
                      }}
                    >
                      {subscription.hidden ? "Restore" : "Hide"}
                    </button>
                    <button
                      type="button"
                      disabled={subscription.unsubscribe_methods.length === 0}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleNewsletterUnsubscribe(subscription);
                      }}
                    >
                      Unsubscribe
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p
              className="nt-newsletter-subscriptions__empty"
              role="status"
              aria-live="polite"
              data-empty-state
            >
              Sync a mailbox with List-ID or List-Unsubscribe headers to build
              subscription groups.
            </p>
          )}
        </section>
      ) : null}

      <div className="nt-scroll-pane">
        {onlyCodes ? (
          paginatedCodeBackedMailMessages.length > 0 ? (
            paginatedCodeBackedMailMessages.map((message) => (
              <div
                className={`nt-message-card nt-message-card--compact nt-message-card--code nt-message-card--selectable ${
                  selectedMailMessageId === message.message_id
                    ? "nt-message-card--active"
                    : ""
                } ${message.is_read ? "" : "nt-message-card--unread"}`}
                key={`${message.sourceLabel}:${message.message_id}`}
              >
                <button
                  type="button"
                  className="nt-message-card__select"
                  aria-label={`选择邮件 ${message.subject}`}
                  aria-pressed={selectedMailMessageIdsSet.has(message.message_id)}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleMailMessageSelection(message.message_id);
                  }}
                >
                  <span className="nt-message-card__checkbox" aria-hidden="true">
                    {selectedMailMessageIdsSet.has(message.message_id) ? "✓" : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className="nt-message-code nt-message-code-copy"
                  aria-label={`复制验证码 ${message.verificationCode.code}`}
                  onClick={(event) =>
                    void copyVerificationCode(event, message.verificationCode.code)
                  }
                >
                  {message.verificationCode.code}
                </button>
                <SenderAvatarIcon
                  value={message.from_address}
                  avatar={senderAvatarFor(message.from_address)}
                  compact={true}
                  onAvatarClick={openAvatarEditor}
                />
                <button
                  type="button"
                  className="nt-message-card__content nt-message-card__open"
                  aria-label={`打开邮件 ${message.subject}`}
                  onClick={() => openMailMessage(message)}
                >
                  <span className="nt-message-card__mainline">
                    <span className="nt-message-card__subject-line">
                      {!message.is_read ? (
                        <span className="nt-message-card__unread-dot" aria-hidden="true" />
                      ) : null}
                      <strong>{message.subject}</strong>
                    </span>
                    <time
                      className="nt-message-card__time"
                      dateTime={message.observed_at}
                    >
                      {formatMailListTime(message.observed_at)}
                    </time>
                  </span>
                  <span>{message.snippet || "暂无预览内容"}</span>
                  {renderMailListStateRow(message)}
                </button>
              </div>
            ))
          ) : (
            <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
              {codeBackedMailMessages.length === 0 && visibleMailMessages.length > 0
                ? "Synced mail has no detected codes."
                : "No verification codes detected yet."}
            </p>
          )
        ) : displayedMailConversations.length > 0 ? (
          paginatedDisplayedMailConversations.map((conversation) => {
            const conversationMessageIds = conversation.messages.map(
              (item) => item.message_id,
            );
            const conversationSelected =
              conversationMessageIds.length > 0 &&
              conversationMessageIds.every((messageId) =>
                selectedMailMessageIdsSet.has(messageId),
              );
            return (
              <MailConversationCard
                key={`${conversation.latestMessage.sourceLabel}:${conversation.key}`}
                conversation={conversation}
                active={selectedMailConversation?.key === conversation.key}
                selected={conversationSelected}
                senderAvatar={senderAvatarFor(conversation.latestMessage.from_address)}
                AvatarComponent={SenderAvatarIcon}
                formatTime={formatMailListTime}
                onOpen={onCardOpen}
                onToggleSelected={onCardToggleSelected}
                onAvatarClick={onCardAvatarClick}
              />
            );
          })
        ) : (
          <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
            暂无{selectedMailboxLabel}邮件。请添加邮箱或执行同步。
          </p>
        )}
      </div>
    </section>
  );
}

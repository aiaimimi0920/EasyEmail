import { memo } from "react";
import type { ComponentType, ReactNode } from "react";

/** The message fields a list card reads. */
export type MailCardMessage = {
  message_id: string;
  from_address: string;
  observed_at: string;
  snippet: string;
  local_folder: string;
  labels: string[];
};

export type MailCardVerificationCode = {
  code: string;
};

export type MailCardConversation<
  TMessage extends MailCardMessage,
  TVerificationCode extends MailCardVerificationCode,
> = {
  key: string;
  subject: string;
  latestMessage: TMessage;
  messages: TMessage[];
  unreadCount: number;
  verificationCode: TVerificationCode | null;
};

/**
 * The avatar type is a parameter rather than a local structural type, so the
 * caller's real DTO flows through. Declaring it structurally here would be
 * narrower than the caller's type and, because component props are
 * contravariant, the real avatar component would not be assignable.
 */
type AvatarComponentType<TAvatar> = ComponentType<{
  value: string;
  avatar?: TAvatar | null;
  compact?: boolean;
  onAvatarClick?: (sender: string, target: HTMLElement) => void;
}>;

/**
 * The chip row beneath a card's snippet. Pure in its arguments, so it lives with
 * the card rather than in `App()`.
 */
export function renderMailListStateRow(
  message: MailCardMessage,
  verificationCode?: MailCardVerificationCode | null,
): ReactNode {
  const visibleLabels = message.labels.slice(0, 1);
  const hiddenLabelCount = Math.max(0, message.labels.length - visibleLabels.length);
  const showFolder = message.local_folder !== "inbox";
  const hasStateChips =
    Boolean(verificationCode) || showFolder || visibleLabels.length > 0 || hiddenLabelCount > 0;

  if (!hasStateChips) {
    return null;
  }

  return (
    <span className="nt-message-state-row">
      {verificationCode ? <em className="nt-code-chip">Code {verificationCode.code}</em> : null}
      {showFolder ? <em className="nt-folder-chip">{message.local_folder}</em> : null}
      {visibleLabels.map((label) => (
        <em key={label} className="nt-label-chip">
          {label}
        </em>
      ))}
      {hiddenLabelCount > 0 ? <em className="nt-more-chip">+{hiddenLabelCount}</em> : null}
    </span>
  );
}

/**
 * Parameterized on the caller's own conversation and avatar types so the handler
 * props stay assignable. Reconstructing those types locally makes them narrower
 * than the caller's, and prop contravariance then rejects the real handlers.
 */
type MailConversationCardProps<
  TConversation extends MailCardConversation<MailCardMessage, MailCardVerificationCode>,
  TAvatar,
> = {
  conversation: TConversation;
  active: boolean;
  selected: boolean;
  senderAvatar: TAvatar | null;
  /** Passed in rather than imported, to keep this file free of an `App.tsx` cycle. */
  AvatarComponent: AvatarComponentType<TAvatar>;
  formatTime: (value: string) => string;
  onOpen: (conversation: TConversation) => void;
  onToggleSelected: (conversation: TConversation, selected: boolean) => void;
  onAvatarClick?: (sender: string, target: HTMLElement) => void;
};

function MailConversationCardInner<
  TConversation extends MailCardConversation<MailCardMessage, MailCardVerificationCode>,
  TAvatar,
>({
  conversation,
  active,
  selected,
  senderAvatar,
  AvatarComponent,
  formatTime,
  onOpen,
  onToggleSelected,
  onAvatarClick,
}: MailConversationCardProps<TConversation, TAvatar>) {
  const message = conversation.latestMessage;

  return (
    <div
      className={`nt-message-card nt-message-card--compact nt-message-card--selectable ${
        active ? "nt-message-card--active" : ""
      } ${conversation.unreadCount > 0 ? "nt-message-card--unread" : ""}`}
    >
      <button
        type="button"
        className="nt-message-card__select"
        aria-label={`选择邮件会话 ${conversation.subject}`}
        aria-pressed={selected}
        onClick={(event) => {
          event.stopPropagation();
          onToggleSelected(conversation, selected);
        }}
      >
        <span className="nt-message-card__checkbox" aria-hidden="true">
          {selected ? "✓" : ""}
        </span>
      </button>
      <AvatarComponent
        value={message.from_address}
        avatar={senderAvatar}
        compact={true}
        onAvatarClick={onAvatarClick}
      />
      <button
        type="button"
        className="nt-message-card__content nt-message-card__open"
        aria-label={`打开邮件会话 ${conversation.subject}`}
        onClick={() => onOpen(conversation)}
      >
        <span className="nt-message-card__mainline">
          <span className="nt-message-card__subject-line">
            {conversation.unreadCount > 0 ? (
              <span className="nt-message-card__unread-dot" aria-hidden="true" />
            ) : null}
            <strong>{conversation.subject}</strong>
            {conversation.messages.length > 1 ? (
              <span className="nt-message-card__count" aria-label="会话邮件数量">
                {conversation.messages.length}
              </span>
            ) : null}
          </span>
          <time className="nt-message-card__time" dateTime={message.observed_at}>
            {formatTime(message.observed_at)}
          </time>
        </span>
        <span>{message.snippet || "暂无预览内容"}</span>
        {renderMailListStateRow(message, conversation.verificationCode)}
      </button>
    </div>
  );
}

/**
 * One row of the mail list.
 *
 * Memoized because ~20 render per page and, before this, a keystroke in any
 * input anywhere in `App()` re-rendered all of them. The memo only pays off
 * while every handler prop is referentially stable, which is what
 * `useEventCallback` is for.
 *
 * `memo` erases the generic signature, so it is restored by assertion.
 */
export const MailConversationCard = memo(
  MailConversationCardInner,
) as typeof MailConversationCardInner;

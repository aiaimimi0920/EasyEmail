import type { CSSProperties } from "react";
import type { AppController } from "../../app/useAppController";

export function MailReadingPane({ controller }: { controller: AppController }) {
  const {
    selectedMailMessage, SenderAvatarIcon, senderAvatarFor, openAvatarEditor, displayNameFromAddress, extractEmailAddress, selectedMessageToAddress, toggleSelectedMailStarred,
    busy, openAdjacentMailMessage, canGoPreviousMailMessage, canGoNextMailMessage, draftReplyToMail, canDraftReply, selectedReplyAccountCanSend, mailMessageMoreMenuOpen,
    mailMoveMenuOpen, mailLabelMenuOpen, setMailMoveMenuOpen, setMailLabelMenuOpen, setMailMessageMoreMenuOpen, draftReplyAllToMail, draftForwardMail, markSelectedMailMessageRead,
    selectedMailMessageIsRead, mailboxView, restoreSelectedMailMessage, deleteSelectedMailMessageForever, archiveSelectedMailMessage, deleteSelectedMailMessage, setSelectedMailFlag, moveSelectedMailMessage,
    localFolderOptions, localLabelOptions, normalizeMailToken, labelSelectedMailMessage, selectedMailConversationMessages, selectedMailConversation, selectedMailMessageId, openMailMessage,
    formatMailListTime, resizeMessageHtmlFrame, renderLinkedMessageText, openUrl,
  } = controller;
  return (
    <article className="nt-reading-pane">
      {selectedMailMessage ? (
        <div className="nt-proton-reading">
          <section className="nt-proton-message-card" aria-label="当前邮件">
            <header className="nt-proton-message-header">
              <SenderAvatarIcon
                value={selectedMailMessage.from_address}
                avatar={senderAvatarFor(selectedMailMessage.from_address)}
                onAvatarClick={openAvatarEditor}
              />
              <div className="nt-proton-header-main">
                <div className="nt-proton-header-line">
                  <strong>{displayNameFromAddress(selectedMailMessage.from_address)}</strong>
                  <span>{extractEmailAddress(selectedMailMessage.from_address)}</span>
                </div>
                <div className="nt-proton-recipient-line">
                  <span>收件人</span>
                  <strong>{selectedMessageToAddress || "当前邮箱"}</strong>
                </div>
              </div>
              <div className="nt-proton-header-meta">
                <div className="nt-proton-header-time-row">
                  <button
                    type="button"
                    className="nt-proton-star"
                    onClick={() => void toggleSelectedMailStarred()}
                    disabled={busy}
                    title="本地星标"
                  >
                    {selectedMailMessage.is_starred ? "已星标" : "星标"}
                  </button>
                  <span>{selectedMailMessage.observed_at}</span>
                </div>
                <div className="nt-proton-header-actions">
                  <div className="nt-proton-header-navigation" aria-label="邮件导航">
                    <button
                      type="button"
                      className="nt-proton-icon-btn"
                      aria-label="上一封邮件"
                      onClick={() => openAdjacentMailMessage(-1)}
                      disabled={!canGoPreviousMailMessage || busy}
                      title="上一封邮件"
                    >
                      上一封
                    </button>
                    <button
                      type="button"
                      className="nt-proton-icon-btn"
                      aria-label="下一封邮件"
                      onClick={() => openAdjacentMailMessage(1)}
                      disabled={!canGoNextMailMessage || busy}
                      title="下一封邮件"
                    >
                      下一封
                    </button>
                  </div>
                  <button
                    type="button"
                    className="nt-proton-primary-reply"
                    onClick={draftReplyToMail}
                    disabled={!canDraftReply || !selectedReplyAccountCanSend || busy}
                      title={
                        selectedReplyAccountCanSend
                          ? "创建回复草稿"
                          : "请先为该账户配置 SMTP 后再回复"
                      }
                    >
                    回复
                  </button>
                  <div className="nt-proton-message-more-anchor">
                    <button
                       type="button"
                       className="nt-proton-icon-btn nt-proton-message-more-trigger"
                       aria-label="更多邮件操作"
                       aria-haspopup="menu"
                        aria-expanded={
                          mailMessageMoreMenuOpen || mailMoveMenuOpen || mailLabelMenuOpen
                        }
                        aria-controls={
                          mailMoveMenuOpen
                            ? "mail-message-move-menu"
                            : mailLabelMenuOpen
                              ? "mail-message-label-menu"
                              : "mail-message-more-menu"
                        }
                       data-nonmodal-trigger="mail-message-more mail-message-move mail-message-label"
                       onClick={() => {
                        setMailMoveMenuOpen(false);
                        setMailLabelMenuOpen(false);
                        setMailMessageMoreMenuOpen((value) => !value);
                      }}
                      disabled={!selectedMailMessage || busy}
                    >
                      ...
                    </button>
                    {mailMessageMoreMenuOpen ? (
                       <div
                         id="mail-message-more-menu"
                         className="nt-proton-message-more-menu"
                         role="menu"
                         aria-label="更多邮件操作"
                         data-nonmodal-layer="mail-message-more"
                       >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMailMessageMoreMenuOpen(false);
                            draftReplyAllToMail();
                          }}
                          disabled={!canDraftReply || !selectedReplyAccountCanSend || busy}
                        >
                          全部回复
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMailMessageMoreMenuOpen(false);
                            draftForwardMail();
                          }}
                          disabled={!canDraftReply || !selectedReplyAccountCanSend || busy}
                        >
                          转发
                        </button>
                         <span className="nt-proton-message-more-menu__divider" role="separator" />
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMailMessageMoreMenuOpen(false);
                            void markSelectedMailMessageRead(!selectedMailMessageIsRead);
                          }}
                          disabled={!selectedMailMessage || busy}
                        >
                          {selectedMailMessageIsRead ? "标记为未读" : "标记为已读"}
                        </button>
                        {mailboxView === "trash" ? (
                          <>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMailMessageMoreMenuOpen(false);
                                void restoreSelectedMailMessage();
                              }}
                              disabled={busy}
                            >
                              恢复
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="nt-proton-message-more-menu__danger"
                              onClick={() => {
                                setMailMessageMoreMenuOpen(false);
                                void deleteSelectedMailMessageForever();
                              }}
                              disabled={busy}
                            >
                              永久删除
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMailMessageMoreMenuOpen(false);
                                void archiveSelectedMailMessage();
                              }}
                              disabled={busy}
                            >
                              归档
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="nt-proton-message-more-menu__danger"
                              onClick={() => {
                                setMailMessageMoreMenuOpen(false);
                                void deleteSelectedMailMessage();
                              }}
                              disabled={busy}
                            >
                              删除
                            </button>
                          </>
                        )}
                         <span className="nt-proton-message-more-menu__divider" role="separator" />
                         <button
                           type="button"
                           role="menuitem"
                          onClick={() => {
                            setMailMessageMoreMenuOpen(false);
                            setMailLabelMenuOpen(false);
                            setMailMoveMenuOpen((value) => !value);
                          }}
                          disabled={busy}
                        >
                          移动到
                        </button>
                         <button
                           type="button"
                           role="menuitem"
                          onClick={() => {
                            setMailMessageMoreMenuOpen(false);
                            setMailMoveMenuOpen(false);
                            setMailLabelMenuOpen((value) => !value);
                          }}
                          disabled={busy}
                        >
                          添加标签
                        </button>
                         <button
                           type="button"
                           role="menuitem"
                          onClick={() => {
                            setMailMessageMoreMenuOpen(false);
                            void setSelectedMailFlag("important", !selectedMailMessage.is_important);
                          }}
                          disabled={busy}
                        >
                          {selectedMailMessage.is_important ? "取消重要标记" : "标记为重要"}
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </header>

            {mailMoveMenuOpen ? (
              <div
                id="mail-message-move-menu"
                className="nt-proton-action-menu"
                role="menu"
                aria-label="移动邮件"
                data-nonmodal-layer="mail-message-move"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void moveSelectedMailMessage("inbox")}
                  disabled={busy}
                >
                  Inbox
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void moveSelectedMailMessage("later")}
                  disabled={busy}
                >
                  Later
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void moveSelectedMailMessage("spam")}
                  disabled={busy}
                >
                  Spam
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void moveSelectedMailMessage("archive")}
                  disabled={busy}
                >
                  Archive
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void moveSelectedMailMessage("trash")}
                  disabled={busy}
                >
                  Trash
                </button>
                {localFolderOptions.length > 0 ? (
                  <span className="nt-proton-action-menu__divider" />
                ) : null}
                {localFolderOptions.map((folder) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={folder.id}
                    onClick={() => void moveSelectedMailMessage(folder.name)}
                    disabled={busy}
                  >
                    <span
                      className="nt-proton-action-menu__color"
                      style={{ "--taxonomy-color": folder.color } as CSSProperties}
                      aria-hidden="true"
                    />
                    {folder.name}
                  </button>
                ))}
              </div>
            ) : null}

            {mailLabelMenuOpen ? (
              <div
                id="mail-message-label-menu"
                className="nt-proton-action-menu"
                role="menu"
                aria-label="为邮件添加标签"
                data-nonmodal-layer="mail-message-label"
              >
                {localLabelOptions.map((label) => {
                  const enabled = selectedMailMessage.labels.some(
                    (value) => normalizeMailToken(value) === normalizeMailToken(label.name),
                  );
                  return (
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={enabled}
                      key={label.id}
                      onClick={() => void labelSelectedMailMessage(label.name, !enabled)}
                      disabled={busy}
                    >
                      <span
                        className="nt-proton-action-menu__color"
                        style={{ "--taxonomy-color": label.color } as CSSProperties}
                        aria-hidden="true"
                      />
                      {enabled ? "移除" : "添加"} {label.name}
                    </button>
                  );
                })}
              </div>
            ) : null}

            <div className="nt-proton-message-body-wrap">
              {selectedMailConversationMessages.length > 1 ? (
              <div className="nt-proton-conversation-stack" aria-label="邮件会话">
                  <div className="nt-proton-conversation-summary">
                    Conversation · {selectedMailConversationMessages.length} messages
                    {selectedMailConversation?.unreadCount
                      ? ` · ${selectedMailConversation.unreadCount} unread`
                      : ""}
                  </div>
                  {selectedMailConversationMessages.map((conversationMessage, index) => {
                    const expanded = conversationMessage.message_id === selectedMailMessageId;
                    const bodySource = expanded ? selectedMailMessage : conversationMessage;
                    return (
                      <section
                        className={`nt-proton-conversation-message ${
                          expanded ? "nt-proton-conversation-message--expanded" : ""
                        }`}
                        key={conversationMessage.message_id}
                      >
                        <button
                          type="button"
                          className="nt-proton-conversation-message__header"
                          onClick={() => openMailMessage(conversationMessage)}
                          disabled={busy}
                        >
                          <SenderAvatarIcon
                            value={conversationMessage.from_address}
                            avatar={senderAvatarFor(conversationMessage.from_address)}
                            compact={true}
                          />
                          <span>
                            <strong>{displayNameFromAddress(conversationMessage.from_address)}</strong>
                            <small>{conversationMessage.snippet || conversationMessage.subject}</small>
                          </span>
                          <time dateTime={conversationMessage.observed_at}>
                            {formatMailListTime(conversationMessage.observed_at)}
                          </time>
                        </button>
                        {expanded ? (
                          "body_html" in bodySource && bodySource.body_html ? (
                            <iframe
                              className="nt-message-html-frame"
                              title={`邮件正文 ${index + 1}/${selectedMailConversationMessages.length}：${displayNameFromAddress(conversationMessage.from_address)} · ${conversationMessage.subject}`}
                              loading="lazy"
                              sandbox="allow-same-origin allow-popups"
                              scrolling="no"
                              onLoad={resizeMessageHtmlFrame}
                              srcDoc={bodySource.body_html}
                            />
                          ) : (
                            <div className="nt-message-body">
                              {renderLinkedMessageText(
                                "body_text" in bodySource
                                  ? bodySource.body_text ?? bodySource.snippet
                                  : bodySource.snippet,
                                openUrl,
                              )}
                            </div>
                          )
                        ) : null}
                      </section>
                    );
                  })}
                </div>
              ) : "body_html" in selectedMailMessage && selectedMailMessage.body_html ? (
                <iframe
                  className="nt-message-html-frame"
                  title={`邮件正文：${displayNameFromAddress(selectedMailMessage.from_address)} · ${selectedMailMessage.subject}`}
                  loading="lazy"
                  sandbox="allow-same-origin allow-popups"
                  scrolling="no"
                  onLoad={resizeMessageHtmlFrame}
                  srcDoc={selectedMailMessage.body_html}
                />
              ) : (
                <div className="nt-message-body">
                  {renderLinkedMessageText(
                    "body_text" in selectedMailMessage
                      ? selectedMailMessage.body_text ?? selectedMailMessage.snippet
                      : selectedMailMessage.snippet,
                    openUrl,
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      ) : (
        <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
          选择一封邮件开始阅读。
        </p>
      )}
    </article>
  );
}

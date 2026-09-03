import type { AppController } from "../../app/useAppController";

export function ComposeActionFooter({ controller }: { controller: AppController }) {
  const {
    discardComposeDraft, composeEncryptionModalOpen, composeEncryptionMenuOpen, openComposeEncryptionModal, composeExternalEncryption, composeAttachmentInputRef, composeAiAssistVisible, setComposeAiAssistVisible,
    composeFormatbarOpen, setComposeFormatbarOpen, composeBottomMoreOpen, setComposeBottomMoreOpen, setComposeEncryptionMenuOpen, setComposeScheduleSendOpen, composePlainTextMode, setComposePlainTextMode,
    composeAttachPublicKey, setComposeAttachPublicKey, composeRequestReadReceipt, setComposeRequestReadReceipt, composeExpirationEnabled, rememberModalReturnFocus, setComposeExpirationModalOpen, composeDraftDirty,
    formatComposeDraftSavedAt, composeDraftSavedAt, composeScheduledAtIso, formatComposeScheduleDate, queueComposePopoverSend, busy, composeScheduleSendOpen, setComposeMoreMenuOpen,
    setComposeEmojiPickerOpen, setComposeAlignmentMenuOpen, setComposeFontMenuOpen, setComposeFontSizeMenuOpen, setComposeColorMenuOpen, clearComposeSchedule, composeSchedulePreset, composeScheduleCustomValue,
    applyComposeCustomScheduleValue,
  } = controller;
  return (
    <footer className="nt-compose-popover__actions">
      <div className="nt-compose-popover__utility-actions">
        <button
          type="button"
          aria-label="删除草稿"
          title="删除草稿"
          onClick={discardComposeDraft}
        >
          🗑
        </button>
        <div className="nt-compose-action-control">
          <button
            type="button"
            aria-label="邮件加密"
            title="邮件加密"
            aria-haspopup="dialog"
            aria-expanded={composeEncryptionModalOpen || composeEncryptionMenuOpen}
            aria-controls={
              composeEncryptionModalOpen ? "compose-encryption-modal" : undefined
            }
            onClick={openComposeEncryptionModal}
          >
            {composeExternalEncryption ? "🔐" : "🔒"}
          </button>
        </div>
        <button
          type="button"
          aria-label="上传附件"
          title="上传附件"
          onClick={() => composeAttachmentInputRef.current?.click()}
        >
          📎
        </button>
        <button
          type="button"
          aria-label={composeAiAssistVisible ? "收起 AI 辅助" : "展开 AI 辅助"}
          title={composeAiAssistVisible ? "收起 AI 辅助" : "展开 AI 辅助"}
          aria-pressed={composeAiAssistVisible}
          onClick={() => setComposeAiAssistVisible((value) => !value)}
        >
          ✦
        </button>
        <button
          type="button"
          aria-label={composeFormatbarOpen ? "收起格式工具栏" : "展开格式工具栏"}
          title={composeFormatbarOpen ? "收起格式工具栏" : "展开格式工具栏"}
          aria-pressed={composeFormatbarOpen}
          onClick={() => setComposeFormatbarOpen((value) => !value)}
        >
          A
        </button>
        <div className="nt-compose-action-control">
          <button
            type="button"
            aria-label="更多写信选项"
            title="更多内容"
            aria-haspopup="menu"
            aria-expanded={composeBottomMoreOpen}
            aria-controls="compose-bottom-more-menu"
            data-nonmodal-trigger="compose-bottom-more"
            onClick={() => {
              setComposeBottomMoreOpen((value) => !value);
              setComposeEncryptionMenuOpen(false);
              setComposeScheduleSendOpen(false);
            }}
          >
            ⋯
          </button>
          {composeBottomMoreOpen ? (
            <div
              id="compose-bottom-more-menu"
              className="nt-compose-popover__bottom-menu"
              role="menu"
              aria-label="更多写信选项"
              data-nonmodal-layer="compose-bottom-more"
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!composePlainTextMode}
                onClick={() => setComposePlainTextMode(false)}
              >
                {!composePlainTextMode ? "✓ " : ""}普通
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={composePlainTextMode}
                onClick={() => setComposePlainTextMode(true)}
              >
                {composePlainTextMode ? "✓ " : ""}纯文本
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={composeAttachPublicKey}
                onClick={() => setComposeAttachPublicKey((value) => !value)}
              >
                {composeAttachPublicKey ? "✓ " : ""}附上公钥
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={composeRequestReadReceipt}
                onClick={() => setComposeRequestReadReceipt((value) => !value)}
              >
                {composeRequestReadReceipt ? "✓ " : ""}请对方发送回执
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={composeExpirationEnabled}
                onClick={() => {
                  rememberModalReturnFocus();
                  setComposeBottomMoreOpen(false);
                  setComposeExpirationModalOpen(true);
                }}
              >
                {composeExpirationEnabled ? "✓ " : ""}邮件有效期
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <span className="nt-compose-popover__saved-state">
        {composeDraftDirty ? "保存中…" : formatComposeDraftSavedAt(composeDraftSavedAt)}
      </span>
      <div className="nt-compose-send-control">
        {composeScheduledAtIso ? (
          <span className="nt-compose-send-control__schedule-summary">
            准备 {formatComposeScheduleDate(new Date(composeScheduledAtIso))}
          </span>
        ) : null}
        <button
          type="button"
          className="nt-compose-popover__send"
          onClick={() => void queueComposePopoverSend()}
          disabled={busy}
        >
          {composeScheduledAtIso ? "定时发送" : "发送"}
        </button>
        <button
          type="button"
          className="nt-compose-popover__send-menu"
          aria-label="打开定时发送选项"
          aria-haspopup="dialog"
          aria-expanded={composeScheduleSendOpen}
          aria-controls="compose-schedule-popover"
          data-nonmodal-trigger="compose-schedule"
          onClick={() => {
            setComposeScheduleSendOpen((value) => !value);
            setComposeBottomMoreOpen(false);
            setComposeEncryptionMenuOpen(false);
            setComposeMoreMenuOpen(false);
            setComposeEmojiPickerOpen(false);
            setComposeAlignmentMenuOpen(false);
            setComposeFontMenuOpen(false);
            setComposeFontSizeMenuOpen(false);
            setComposeColorMenuOpen(false);
          }}
        >
          ⌄
        </button>
        {composeScheduleSendOpen ? (
          <div
            id="compose-schedule-popover"
            className="nt-compose-schedule-popover"
            role="dialog"
            aria-label="定时发送"
            data-nonmodal-layer="compose-schedule"
          >
            <header>
              <strong>定时发送</strong>
              <span>您想何时发送邮件?</span>
            </header>
            <button type="button" onClick={clearComposeSchedule}>
              <span>{composeScheduledAtIso ? "" : "✓ "}直接发送</span>
              <em>取消定时</em>
            </button>
            <div className="nt-compose-schedule-custom" role="group" aria-label="其他发送时间">
              <span className="nt-compose-schedule-custom__label">
                {composeSchedulePreset === "custom" ? "✓ " : ""}其他
              </span>
              <input
                aria-label="选择其他发送时间"
                type="datetime-local"
                step={60}
                value={composeScheduleCustomValue}
                onChange={(event) => applyComposeCustomScheduleValue(event.currentTarget.value)}
              />
            </div>
          </div>
        ) : null}
      </div>
    </footer>
  );
}

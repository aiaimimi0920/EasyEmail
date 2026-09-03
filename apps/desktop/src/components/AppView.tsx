import type { ManualImapAccountCreateRequest } from "../api/mailAccountClient";
import type { AppController } from "../app/useAppController";

import { ComposeWindowHeader } from "./app/ComposeWindowHeader";
import { ComposeAddressFields } from "./app/ComposeAddressFields";
import { ComposeBodyEditor } from "./app/ComposeBodyEditor";
import { ComposeFormatToolbar } from "./app/ComposeFormatToolbar";
import { ComposeActionFooter } from "./app/ComposeActionFooter";
import { ComposeEncryptionDialog } from "./app/ComposeEncryptionDialog";
import { ComposeExpirationDialog } from "./app/ComposeExpirationDialog";
import { ComposeLinkDialog } from "./app/ComposeLinkDialog";
import { MailTaxonomyDialog } from "./app/MailTaxonomyDialog";
import { ContactDialog } from "./app/ContactDialog";
import { ComposeRecipientMenu } from "./app/ComposeRecipientMenu";
import { AvatarEditorPopover } from "./app/AvatarEditorPopover";
import { SideRail } from "./app/SideRail";
import { MailSearchBar } from "./app/MailSearchBar";
import { MailSearchOverlay } from "./app/MailSearchOverlay";
import { MailTopbarActions } from "./app/MailTopbarActions";
import { MailListToolbar } from "./app/MailListToolbar";
import { MailListPane } from "./app/MailListPane";
import { MailReadingPane } from "./app/MailReadingPane";
import { MailSourceDrawer } from "./app/MailSourceDrawer";
import { AgentWorkspace } from "./app/AgentWorkspace";
import { QueueWorkspace } from "./app/QueueWorkspace";
import { EasyEmailSetupPanel } from "./app/EasyEmailSetupPanel";
import { MailAccountSetupPanel } from "./app/MailAccountSetupPanel";
export function AppView({ controller }: { controller: AppController }) {
  const {
    activeView, railCollapsed, busy, initializing, statusMessage, avatarFileInputRef, handleContactAvatarFile, platformAvatarFileInputRef,
    handlePlatformAvatarFile, avatarEditor, platformAccountMenuOpen, setPlatformAccountMenuOpen, platformAccountSignedIn, platformAccountAvatarDataUrl, platformAccountInitial, platformAccountPopoverTitle,
    platformAccountPopoverEmail, signOutPlatformAccount, signInPlatformAccount, railModePickerOpen, setRailModePickerOpen, railMode, selectRailMode, RailIcon,
    composePopoverOpen, composePopoverMinimized, composePopoverExpanded, composeFormatbarOpen, composeAttachments, composeEncryptionModalOpen, composeAttachmentInputRef, composeExpirationModalOpen,
    composeImageInputRef, handleComposeImageFile, handleComposeAttachmentFiles, composeLinkModalOpen, mailTaxonomyManagerKind, contactModalOpen, composeRecipientMenu, setComposeRecipientMenu,
    submitMailSearch, mailSearchOverlayOpen, mailReadingExpanded, mailAccountPanelOpen, setMailAccountPanelOpen, applyQqMailPreset, normalDisplayName, setNormalDisplayName,
    normalEmailAddress, updateNormalEmailAddress, normalImapPassword, updateMailboxAuthorizationCode, mailboxLoginUsername, normalImapHost, normalImapPort, setMailAccountPanelAdvancedOpen,
    mailAccountPanelAdvancedOpen, setNormalImapHost, setNormalImapPort, normalImapSecurity, setNormalImapSecurity, addManualImapAccount, mailSourceDrawerOpen, visibleMailMessages,
    toastMessage, toastKey, toastVisibleKey, error, copyToast, toastFading, dismissCurrentToast,
  } = controller;
  return (
    <main
      className={`nt-app-shell nt-app-shell--edge-rail ${
        activeView === "mail" ? "nt-app-shell--mail-compact" : ""
      } ${
        railCollapsed ? "nt-app-shell--rail-collapsed" : "nt-app-shell--rail-expanded"
      }`}
      data-view={activeView}
      aria-busy={busy}
    >
      {busy ? (
        <div className="nt-global-busy" role="status" aria-live="polite" aria-atomic="true">
          <span className="nt-global-busy__bar" aria-hidden="true" />
          {initializing ? (
            <span className="nt-global-busy__message">{statusMessage}</span>
          ) : (
            <span className="nt-visually-hidden">正在处理</span>
          )}
        </div>
      ) : null}
      <input
        ref={avatarFileInputRef}
        className="nt-hidden-file-input"
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,image/x-icon"
        onChange={handleContactAvatarFile}
      />
      <input
        ref={platformAvatarFileInputRef}
        className="nt-hidden-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon"
        onChange={handlePlatformAvatarFile}
      />
      {avatarEditor ? (
        <AvatarEditorPopover controller={controller} />
      ) : null}
      {platformAccountMenuOpen && !railCollapsed ? (
        <>
          <button
            type="button"
            className="nt-platform-account-popover-backdrop"
            aria-label="关闭平台账户菜单"
            onClick={() => setPlatformAccountMenuOpen(false)}
          />
          <section
            className={`nt-platform-account-popover ${
              platformAccountSignedIn ? "nt-platform-account-popover--signed-in" : "nt-platform-account-popover--signed-out"
            }`}
            role="dialog"
            aria-label="平台账户菜单"
            data-nonmodal-layer="platform-account"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="nt-platform-account-popover__hero">
              <span className="nt-platform-account-popover__avatar" aria-hidden="true">
                {platformAccountSignedIn && platformAccountAvatarDataUrl ? (
                  <img src={platformAccountAvatarDataUrl} alt="" />
                ) : platformAccountSignedIn ? (
                  platformAccountInitial
                ) : (
                  "N"
                )}
              </span>
              <strong>{platformAccountPopoverTitle}</strong>
              <span>{platformAccountPopoverEmail}</span>
            </div>

            <div className="nt-platform-account-popover__actions">
              {platformAccountSignedIn ? (
                <button
                  type="button"
                  className="nt-platform-account-popover__danger"
                  onClick={signOutPlatformAccount}
                  disabled={busy}
                >
                  退出预览账户
                </button>
              ) : (
                <button
                  type="button"
                  className="nt-platform-account-popover__primary"
                  onClick={() => void signInPlatformAccount()}
                  disabled={busy}
                >
                  使用开发预览账户登录
                </button>
              )}
            </div>
          </section>
        </>
      ) : null}
      {railModePickerOpen && railCollapsed ? (
        <>
          <button
            type="button"
            className="nt-mode-popover-backdrop"
            aria-label="关闭模式选择器"
            onClick={() => setRailModePickerOpen(false)}
          />
          <section
            className="nt-mode-popover"
            role="menu"
            aria-label="邮件模式选择器"
            data-nonmodal-layer="rail-mode"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitemradio"
              data-mode="mail"
              aria-label="切换到邮件模式"
              aria-checked={railMode === "mail"}
              title="邮件"
              className={`nt-mode-popover__item ${
                railMode === "mail" ? "nt-mode-popover__item--active" : ""
              }`}
              onClick={() => selectRailMode("mail")}
            >
              <span className="nt-mode-popover__icon">
                <RailIcon kind="mail" />
              </span>
            </button>
            <button
              type="button"
              role="menuitemradio"
              data-mode="agent"
              aria-label="切换到代理模式"
              aria-checked={railMode === "agent"}
              title="代理"
              className={`nt-mode-popover__item ${
                railMode === "agent" ? "nt-mode-popover__item--active" : ""
              }`}
              onClick={() => selectRailMode("agent")}
            >
              <span className="nt-mode-popover__icon">
                <RailIcon kind="agent" />
              </span>
            </button>
          </section>
        </>
      ) : null}
      {composePopoverOpen ? (
        <>
          <div className="nt-compose-popover-backdrop" aria-hidden="true" />
          <section
            className={`nt-compose-popover ${
              composePopoverMinimized ? "nt-compose-popover--minimized" : ""
            } ${composePopoverExpanded ? "nt-compose-popover--expanded" : ""}`}
            role="dialog"
            id="compose-popover"
            aria-label="写邮件"
            aria-modal="false"
            data-nonmodal-layer="compose-popover"
            data-nonmodal-preserve-focus
          >
            <ComposeWindowHeader controller={controller} />

            {!composePopoverMinimized ? (
              <>
                <ComposeAddressFields controller={controller} />

                <ComposeBodyEditor controller={controller} />

                {composeFormatbarOpen ? (
                  <ComposeFormatToolbar controller={controller} />
                ) : null}

                {composeAttachments.length > 0 ? (
                  <div className="nt-compose-attachments" aria-label="待发送附件">
                    {composeAttachments.map((attachment) => (
                      <span key={attachment.id}>
                        📎 {attachment.name}
                        <em>{Math.ceil(attachment.size / 1024)} KB</em>
                      </span>
                    ))}
                  </div>
                ) : null}

                <ComposeActionFooter controller={controller} />
              </>
            ) : null}
            {composeEncryptionModalOpen ? (
              <>
                <div className="nt-compose-encryption-modal-backdrop" aria-hidden="true" />
                <ComposeEncryptionDialog controller={controller} />
              </>
            ) : null}
          </section>
        </>
      ) : null}
      {composeExpirationModalOpen ? (
        <>
          <div className="nt-compose-expiration-modal-backdrop" aria-hidden="true" />
          <ComposeExpirationDialog controller={controller} />
        </>
      ) : null}
      <input
        ref={composeImageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={handleComposeImageFile}
      />
      <input
        ref={composeAttachmentInputRef}
        type="file"
        multiple
        hidden
        onChange={handleComposeAttachmentFiles}
      />
      {composeLinkModalOpen ? (
        <>
          <div className="nt-compose-link-modal-backdrop" aria-hidden="true" />
          <ComposeLinkDialog controller={controller} />
        </>
      ) : null}
      {mailTaxonomyManagerKind ? (
        <>
          <div className="nt-mail-taxonomy-modal-backdrop" aria-hidden="true" />
          <MailTaxonomyDialog controller={controller} />
        </>
      ) : null}
      {contactModalOpen ? (
        <>
          <div className="nt-contact-modal-backdrop" aria-hidden="true" />
          <ContactDialog controller={controller} />
        </>
      ) : null}
      {composeRecipientMenu ? (
        <>
          <div
            className="nt-compose-recipient-menu-backdrop"
            aria-hidden="true"
            onClick={() => setComposeRecipientMenu(null)}
          />
          <ComposeRecipientMenu controller={controller} />
        </>
      ) : null}
      <SideRail controller={controller} />

      <section className="nt-workspace-board">
        {activeView === "mail" ? (
          <section className="nt-board-view nt-board-view--mail">
            <div className="nt-mail-topbar">
              <form
                className="nt-mail-search-region"
                role="search"
                onSubmit={submitMailSearch}
              >
                <MailSearchBar controller={controller} />

              {mailSearchOverlayOpen ? (
                <MailSearchOverlay controller={controller} />
              ) : null}
              </form>

              <MailTopbarActions controller={controller} />
            </div>

            {mailAccountPanelOpen ? (
              <div className="nt-mail-account-panel-scrim" role="presentation">
                <aside
                  className="nt-mail-account-panel"
                  role="dialog"
                  aria-modal="true"
                  aria-label="添加长效邮箱"
                  data-modal-id="mail-account"
                  tabIndex={-1}
                >
                  <div className="nt-mail-account-panel__head">
                    <div>
                      <p className="nt-kicker">长效邮箱</p>
                      <h2>添加邮箱</h2>
                    </div>
                    <button
                      type="button"
                      className="nt-mini-btn"
                      onClick={() => setMailAccountPanelOpen(false)}
                    >
                      关闭
                    </button>
                  </div>

                  <div className="nt-mail-account-panel__preset">
                    <button
                      type="button"
                      className="nt-btn nt-btn--secondary"
                      onClick={applyQqMailPreset}
                    >
                      QQ 邮箱预设
                    </button>
                    <span>QQ 邮箱 / IMAP 993 / TLS / 使用授权码（SMTP 在 M5）</span>
                  </div>

                  <div className="nt-scroll-pane nt-mail-account-panel__body">
                    <div className="nt-form-grid">
                      <label>
                        显示名称
                        <input
                          data-modal-initial-focus
                          value={normalDisplayName}
                          placeholder="QQ Mail"
                          onChange={(event) => setNormalDisplayName(event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        邮箱地址
                        <input
                          value={normalEmailAddress}
                          placeholder="123456@qq.com"
                          onChange={(event) => updateNormalEmailAddress(event.currentTarget.value)}
                        />
                      </label>
                      <label className="nt-wide-field">
                        授权码
                        <input
                          type="password"
                          value={normalImapPassword}
                          placeholder="QQ 邮箱授权码"
                          onChange={(event) => updateMailboxAuthorizationCode(event.currentTarget.value)}
                        />
                      </label>
                      <div className="nt-derived-grid nt-wide-field">
                        <span>登录</span>
                        <strong>{mailboxLoginUsername() || "邮箱地址"}</strong>
                        <span>收取</span>
                        <strong>
                          {normalImapHost || "imap.qq.com"}:{normalImapPort || "993"}
                        </strong>
                        <span>发送</span>
                        <strong>SMTP 将在 M5 迁移</strong>
                      </div>
                      <button
                        type="button"
                        className="nt-mini-btn nt-wide-field"
                        onClick={() => setMailAccountPanelAdvancedOpen((value) => !value)}
                      >
                        {mailAccountPanelAdvancedOpen ? "隐藏高级设置" : "高级服务器设置"}
                      </button>
                      {mailAccountPanelAdvancedOpen ? (
                        <>
                          <label>
                            IMAP 主机
                            <input
                              value={normalImapHost}
                              placeholder="imap.qq.com"
                              onChange={(event) => setNormalImapHost(event.currentTarget.value)}
                            />
                          </label>
                          <label>
                            IMAP 端口
                            <input
                              value={normalImapPort}
                              inputMode="numeric"
                              placeholder="993"
                              onChange={(event) => setNormalImapPort(event.currentTarget.value)}
                            />
                          </label>
                          <label>
                            IMAP 安全模式
                            <select
                              value={normalImapSecurity}
                              onChange={(event) => setNormalImapSecurity(
                                event.currentTarget.value as ManualImapAccountCreateRequest["imap_security"],
                              )}
                            >
                              <option value="tls">TLS</option>
                              <option value="starttls">STARTTLS</option>
                            </select>
                          </label>
                          <p className="nt-form-note nt-wide-field">
                            当前 M3 只保存 IMAP 配置。SMTP 主机、端口和发信凭据将在 M5 发送队列切片中迁移。
                          </p>
                        </>
                      ) : null}
                    </div>
                  </div>

                  <div className="nt-mail-account-panel__foot">
                    <button
                      type="button"
                      className="nt-btn nt-btn--primary"
                      onClick={() => void addManualImapAccount()}
                      disabled={busy}
                    >
                      保存并测试 IMAP
                    </button>
                  </div>
                </aside>
              </div>
            ) : null}

            <div
              className={`nt-mail-adaptive ${
                mailSourceDrawerOpen ? "nt-mail-adaptive--drawer-open" : ""
              } ${mailReadingExpanded ? "nt-mail-adaptive--reading" : ""} ${
                visibleMailMessages.length === 0 ? "nt-mail-adaptive--empty" : ""
              }`}
            >
              <MailListToolbar controller={controller} />

              <MailListPane controller={controller} />

              {visibleMailMessages.length > 0 ? (
              <MailReadingPane controller={controller} />
              ) : null}

              {mailSourceDrawerOpen ? (
              <MailSourceDrawer controller={controller} />
              ) : null}
            </div>
          </section>
        ) : null}

        {activeView === "agent" ? (
          <AgentWorkspace controller={controller} />
        ) : null}

        {activeView === "queue" ? (
          <QueueWorkspace controller={controller} />
        ) : null}

        {activeView === "setup" ? (
          <section className="nt-board-view">
            <div className="nt-board-head">
              <div>
                <p className="nt-kicker">SETUP</p>
                <h1>Provider and mailbox ignition</h1>
                <span>Configure EasyEmail, long-lived IMAP accounts, and temporary mailbox creation.</span>
              </div>
            </div>

            <div className="nt-two-column">
              <EasyEmailSetupPanel controller={controller} />

              <MailAccountSetupPanel controller={controller} />
            </div>
          </section>
        ) : null}
      </section>
      {toastMessage && toastKey && toastVisibleKey === toastKey ? (
        <div
          className={`nt-copy-toast ${
            error
              ? "nt-copy-toast--error"
              : copyToast
                ? "nt-copy-toast--success"
                : "nt-copy-toast--status"
          } ${composePopoverOpen ? "nt-copy-toast--compose-open" : ""} ${
            toastFading ? "nt-copy-toast--fade" : ""
          }`}
          role={error ? "alert" : "status"}
          aria-live={error ? "assertive" : "polite"}
          aria-atomic="true"
        >
          <span className="nt-copy-toast__state" aria-hidden="true">
            {error ? "!" : copyToast ? "✓" : "i"}
          </span>
          <span className="nt-copy-toast__content">
            <span>{toastMessage}</span>
            {error?.correlation_id ? (
              <small>关联 ID: {error.correlation_id}</small>
            ) : null}
          </span>
          <button
            type="button"
            className="nt-copy-toast__dismiss"
            aria-label="关闭通知"
            onClick={dismissCurrentToast}
          >
            ×
          </button>
        </div>
      ) : null}
    </main>
  );
}

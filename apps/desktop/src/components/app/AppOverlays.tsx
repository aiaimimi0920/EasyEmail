import type { AppController } from "../../app/useAppController";

import { AvatarEditorPopover } from "./AvatarEditorPopover";

export function AppOverlays({ controller }: { controller: AppController }) {
  const {
    busy,
    initializing,
    statusMessage,
    avatarFileInputRef,
    handleContactAvatarFile,
    platformAvatarFileInputRef,
    handlePlatformAvatarFile,
    avatarEditor,
    platformAccountMenuOpen,
    railCollapsed,
    setPlatformAccountMenuOpen,
    platformAccountSignedIn,
    platformAccountAvatarDataUrl,
    platformAccountInitial,
    platformAccountPopoverTitle,
    platformAccountPopoverEmail,
    signOutPlatformAccount,
    signInPlatformAccount,
    railModePickerOpen,
    setRailModePickerOpen,
    railMode,
    selectRailMode,
    RailIcon,
  } = controller;

  return (
    <>
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
      {avatarEditor ? <AvatarEditorPopover controller={controller} /> : null}
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
              platformAccountSignedIn
                ? "nt-platform-account-popover--signed-in"
                : "nt-platform-account-popover--signed-out"
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
    </>
  );
}

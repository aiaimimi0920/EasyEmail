import type { AppController } from "../../app/useAppController";

export function MailSearchBar({ controller }: { controller: AppController }) {
  const {
    mailSearchOverlayOpen, SearchMagnifierIcon, mailSearchQuery, setMailSearchOverlayOpen, setMailSearchQuery, onlyCodes, setOnlyCodes, mailSyncInProgress,
    selectedMailSource, closeMailSearchOverlay, syncCurrentMailSource, busy,
  } = controller;
  return (
    <div className="nt-mail-search-bar">
      <label
        className={`nt-mail-top-search ${
          mailSearchOverlayOpen ? "nt-mail-top-search--active" : ""
        }`}
      >
        <span className="nt-mail-top-search__icon">
          <SearchMagnifierIcon />
        </span>
        <input
          value={mailSearchQuery}
          placeholder="搜索邮件"
          aria-label="搜索邮件"
          aria-haspopup="dialog"
          aria-expanded={mailSearchOverlayOpen}
          aria-controls="mail-search-overlay"
          data-nonmodal-trigger="mail-search"
          onFocus={() => setMailSearchOverlayOpen(true)}
          onChange={(event) => setMailSearchQuery(event.currentTarget.value)}
        />
        {mailSearchQuery ? (
          <button
            type="button"
            className="nt-mail-top-search__clear"
            aria-label="清空搜索"
            onClick={() => setMailSearchQuery("")}
          >
            清除
          </button>
        ) : null}
      </label>
      <div className="nt-mail-search-actions">
        <button
          type="button"
          className={`nt-mail-search-code-switch ${
            onlyCodes ? "nt-mail-search-code-switch--active" : ""
          }`}
          aria-label="仅显示包含验证码的邮件"
          aria-pressed={onlyCodes}
          onClick={() => setOnlyCodes((value) => !value)}
        >
          {onlyCodes ? "CODES on" : "CODES"}
        </button>
        <button
          type="button"
          className={`nt-mail-search-sync-button ${
            mailSyncInProgress ? "nt-mail-search-sync-button--syncing" : ""
          }`}
          aria-label="同步当前邮箱"
          aria-busy={mailSyncInProgress}
          title={mailSyncInProgress ? `Syncing ${selectedMailSource.label}` : `Sync ${selectedMailSource.label}`}
          onClick={() => {
            closeMailSearchOverlay();
            void syncCurrentMailSource();
          }}
          disabled={busy || mailSyncInProgress}
        >
          {mailSyncInProgress ? "SYNCING" : "SYNC"}
        </button>
      </div>
    </div>
  );
}

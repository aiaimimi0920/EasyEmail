import type { AppController } from "../../app/useAppController";

export function MailTopbarActions({ controller }: { controller: AppController }) {
  const {
    mailboxView, emptyCurrentTrash, busy, trashMessageCount, selectedMailMessage, mailReadingExpanded, setMailReadingExpanded, mailSourceDropdownOpen,
    selectedMailSource, closeMailSearchOverlay, setMailSourceDropdownOpen, mailSources, mailSourceId, selectMailSource, openMailAccountPanelFromSourceDropdown, createTempMailboxFromSourceDropdown,
  } = controller;
  return (
    <div className="nt-mail-topbar__actions">
      {mailboxView === "trash" ? (
        <button
          type="button"
          className="nt-btn nt-btn--outline nt-mail-topbar__action"
          onClick={() => void emptyCurrentTrash()}
          disabled={busy || trashMessageCount === 0}
        >
          清空回收站
        </button>
      ) : null}
      {selectedMailMessage ? (
        <button
          type="button"
          className="nt-btn nt-btn--secondary nt-mail-topbar__action nt-mail-topbar__action--expand"
          aria-pressed={mailReadingExpanded}
          onClick={() => setMailReadingExpanded((value) => !value)}
        >
          {mailReadingExpanded ? "退出聚焦" : "展开阅读"}
        </button>
      ) : null}
      <div className="nt-mail-source-selector">
        <button
          type="button"
          className="nt-mail-source-selector__trigger"
          data-modal-return-focus="mail-account"
          aria-label="选择当前邮箱账号"
          aria-haspopup="dialog"
          aria-expanded={mailSourceDropdownOpen}
          aria-controls="mail-source-selector-menu"
          data-nonmodal-trigger="mail-source"
          title={`当前邮箱账号: ${selectedMailSource.label}`}
          onClick={() => {
            closeMailSearchOverlay();
            setMailSourceDropdownOpen((value) => !value);
          }}
        >
          <span className="nt-mail-source-selector__kicker">当前邮箱账号</span>
          <strong>{selectedMailSource.label}</strong>
          <span className="nt-mail-source-selector__chevron" aria-hidden="true">
            {mailSourceDropdownOpen ? "⌃" : "⌄"}
          </span>
        </button>
        {mailSourceDropdownOpen ? (
          <div
            id="mail-source-selector-menu"
            className="nt-mail-source-selector__menu"
            role="dialog"
            aria-label="当前邮箱账号与添加操作"
            data-nonmodal-layer="mail-source"
          >
            <div
              className="nt-mail-source-selector__options"
              role="listbox"
              aria-label="当前邮箱账号"
              data-nonmodal-navigation
            >
              {mailSources.map((source) => (
                <button
                  type="button"
                  key={source.id}
                  className={`nt-mail-source-selector__option nt-mail-source-selector__option--${source.tone} ${
                    mailSourceId === source.id ? "nt-mail-source-selector__option--active" : ""
                  }`}
                  role="option"
                  aria-selected={mailSourceId === source.id}
                  onClick={() => selectMailSource(source.id)}
                >
                  <strong>{source.label}</strong>
                </button>
              ))}
            </div>
            <div className="nt-mail-source-selector__actions" role="group" aria-label="添加邮箱操作">
              <button
                type="button"
                className="nt-mail-source-selector__action"
                onClick={openMailAccountPanelFromSourceDropdown}
              >
                添加长效邮箱
              </button>
              <button
                type="button"
                className="nt-mail-source-selector__action nt-mail-source-selector__action--primary"
                onClick={createTempMailboxFromSourceDropdown}
                disabled={busy}
              >
                创建并添加临时邮箱
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

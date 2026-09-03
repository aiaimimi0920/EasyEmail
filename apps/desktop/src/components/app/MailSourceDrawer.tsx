import type { AppController } from "../../app/useAppController";

export function MailSourceDrawer({ controller }: { controller: AppController }) {
  const {
    setMailSourceDrawerOpen, mailSources, mailSourceId, selectMailSource, createTempMailbox, busy,
  } = controller;
  return (
    <aside id="mail-source-drawer" className="nt-source-drawer" aria-label="邮件来源抽屉">
      <div className="nt-source-drawer__head">
        <div>
        <p className="nt-kicker">邮件来源</p>
        <h2>选择邮件来源</h2>
        </div>
        <button
          type="button"
          className="nt-mini-btn"
          onClick={() => setMailSourceDrawerOpen(false)}
        >
          Close
        </button>
      </div>
      <div className="nt-source-list">
        {mailSources.map((source) => (
          <button
            type="button"
            key={source.id}
            className={`nt-source-card nt-source-card--${source.tone} ${
              mailSourceId === source.id ? "nt-source-card--active" : ""
            }`}
            onClick={() => selectMailSource(source.id)}
          >
            <strong>{source.label}</strong>
          </button>
        ))}
      </div>
      <div className="nt-divider" />
      <button
        type="button"
        className="nt-btn nt-btn--primary"
        onClick={createTempMailbox}
        disabled={busy}
      >
        New temp mailbox
      </button>
    </aside>
  );
}

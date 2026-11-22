import type { ManualImapAccountCreateRequest } from "../../api/mailAccountClient";
import type { AppController } from "../../app/useAppController";

export function MailAccountSetupPanel({ controller }: { controller: AppController }) {
  const {
    applyQqMailPreset, normalDisplayName, setNormalDisplayName, normalEmailAddress, updateNormalEmailAddress, normalImapPassword, updateMailboxAuthorizationCode, mailboxLoginUsername,
    normalImapHost, normalImapPort, setMailAccountPanelAdvancedOpen, mailAccountPanelAdvancedOpen, setNormalImapHost, setNormalImapPort, normalImapSecurity, setNormalImapSecurity,
    addManualImapAccount, busy, normalImapTest, normalImapAccounts, setSelectedNormalAccountId, setMailSourceId, setStatusMessage, testNormalImap,
    disableNormalAccount, deleteNormalAccount,
  } = controller;
  return (
    <section className="nt-action-board">
      <div className="nt-section-title-row">
        <p className="nt-kicker">MAIL ACCOUNT</p>
        <button
          type="button"
          className="nt-mini-btn nt-mini-btn--signal"
          onClick={applyQqMailPreset}
        >
          QQ preset
        </button>
      </div>
      <div className="nt-form-grid">
        <label>
          Display name
          <input
            value={normalDisplayName}
            placeholder="Work"
            onChange={(event) => setNormalDisplayName(event.currentTarget.value)}
          />
        </label>
        <label>
          Email address
          <input
            autoComplete="email"
            type="email"
            value={normalEmailAddress}
            placeholder="work@example.com"
            onChange={(event) => updateNormalEmailAddress(event.currentTarget.value)}
          />
        </label>
        <label className="nt-wide-field">
          Authorization code
          <input
            autoComplete="off"
            type="password"
            value={normalImapPassword}
            placeholder="QQ authorization code, not QQ login password"
            onChange={(event) => updateMailboxAuthorizationCode(event.currentTarget.value)}
          />
        </label>
        <div className="nt-derived-grid nt-wide-field">
          <span>Login</span>
          <strong>{mailboxLoginUsername() || "email address"}</strong>
          <span>Receive</span>
          <strong>
            {normalImapHost || "imap.qq.com"}:{normalImapPort || "993"}
          </strong>
          <span>Send</span>
          <strong>SMTP migrates in M5</strong>
        </div>
        <button
          type="button"
          className="nt-mini-btn nt-wide-field"
          onClick={() => setMailAccountPanelAdvancedOpen((value) => !value)}
        >
          {mailAccountPanelAdvancedOpen ? "Hide advanced" : "Advanced server settings"}
        </button>
        {mailAccountPanelAdvancedOpen ? (
          <>
            <label>
              IMAP host
              <input
                autoComplete="off"
                value={normalImapHost}
                placeholder="imap.example.com"
                onChange={(event) => setNormalImapHost(event.currentTarget.value)}
              />
            </label>
            <label>
              IMAP port
              <input
                value={normalImapPort}
                inputMode="numeric"
                placeholder="993"
                onChange={(event) => setNormalImapPort(event.currentTarget.value)}
              />
            </label>
            <label>
              IMAP security
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
              This M3 slice stores IMAP only. SMTP settings and send credentials move with the M5 queue slice.
            </p>
          </>
        ) : null}
      </div>
      <div className="nt-result">
        <strong>QQ Mail</strong>
        <span>IMAP imap.qq.com:993 TLS. SMTP setup is deferred to M5.</span>
        <small>Enable IMAP in QQ Mail web settings and paste the generated authorization code.</small>
      </div>
      <div className="nt-actions">
        <button type="button" className="nt-btn nt-btn--primary" onClick={() => void addManualImapAccount()} disabled={busy}>
          Save and test IMAP
        </button>
      </div>
      {normalImapTest ? (
        <div className="nt-result">
          <strong>{normalImapTest.authenticated ? "Authenticated" : "Not authenticated"}</strong>
          <span>{normalImapTest.capability_summary}</span>
        </div>
      ) : null}
      <div className="nt-scroll-pane nt-scroll-pane--short">
        {normalImapAccounts.length > 0 ? (
          normalImapAccounts.map((account) => (
            <article className="nt-resource-row" key={account.id}>
              <strong>{account.display_name}</strong>
              <span>{account.primary_address ?? "No address"}</span>
              <small>
                {account.auth_status} / {account.receive_status} / {account.send_status}
              </small>
              <div className="nt-row-actions">
                <button
                  type="button"
                  className="nt-mini-btn"
                  onClick={() => {
                    setSelectedNormalAccountId(account.id);
                    setMailSourceId(`account:${account.id}`);
                    setStatusMessage("Message synchronization becomes available in M6.");
                  }}
                  disabled={busy}
                >
                  View
                </button>
                <button
                  type="button"
                  className="nt-mini-btn"
                  onClick={() => void testNormalImap(account)}
                  disabled={busy}
                >
                  Test IMAP
                </button>
                {account.status !== "disabled" ? (
                  <button
                    type="button"
                    className="nt-mini-btn"
                    onClick={() => void disableNormalAccount(account)}
                    disabled={busy}
                  >
                    Disable
                  </button>
                ) : null}
                <button
                  type="button"
                  className="nt-mini-btn"
                  onClick={() => void deleteNormalAccount(account)}
                  disabled={busy}
                >
                  Delete
                </button>
              </div>
            </article>
          ))
        ) : (
          <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
            No manual IMAP accounts yet.
          </p>
        )}
      </div>
    </section>
  );
}

import type { AppController } from "../../app/useAppController";

export function EasyEmailSetupPanel({ controller }: { controller: AppController }) {
  const {
    serviceUrl, setServiceUrl, apiToken, setApiToken, saveSettings, busy, testConnection, easyEmailHealth,
    avatarSettings, setAvatarSettings, saveAvatarSettings, clearSenderAvatarCache, targetService, setTargetService, note, setNote,
    waitForCode, setWaitForCode, createAndSelectTempMailbox, refreshAnonymousMail, tempRecoveryEmail, setTempRecoveryEmail, tempRecoveryProviderType, setTempRecoveryProviderType,
    recoverTempMailbox, selectedTempMailboxId, setSelectedTempMailboxId, tempMailboxes, tempMailboxFromContains, setTempMailboxFromContains, tempOutcomeFailureReason, setTempOutcomeFailureReason,
    tempSendTo, setTempSendTo, tempSendSubject, setTempSendSubject, tempSendBody, setTempSendBody, readTempMailboxAuthenticationLink, updateTempMailboxSession,
    reportTempMailboxOutcome, sendTempMailboxMessage, releaseTempMailbox, lastAuthenticationLink, openLastTempMailboxAuthenticationLink, lastRefresh, lastPromotion, refreshMailbox,
    promoteMailbox,
  } = controller;
  return (
    <section className="nt-action-board">
      <p className="nt-kicker">EASYEMAIL</p>
      <div className="nt-form-grid nt-form-grid--single">
        <label>
          Service URL
          <input
            value={serviceUrl}
            placeholder="http://127.0.0.1:8080"
            onChange={(event) => setServiceUrl(event.currentTarget.value)}
          />
        </label>
        <label>
          One-shot API token
          <input
            type="password"
            value={apiToken}
            placeholder="Not stored in SQLite"
            onChange={(event) => setApiToken(event.currentTarget.value)}
          />
        </label>
      </div>
      <div className="nt-actions">
        <button type="button" className="nt-btn nt-btn--primary" onClick={saveSettings} disabled={busy}>
          Save URL
        </button>
        <button type="button" className="nt-btn nt-btn--secondary" onClick={testConnection} disabled={busy}>
          Test connection
        </button>
      </div>
      {easyEmailHealth ? (
        <div className="nt-result">
          <strong>{easyEmailHealth.reachable ? "Reachable" : "Unreachable"}</strong>
          <span>{easyEmailHealth.capabilities_summary}</span>
          <small>Auth: {easyEmailHealth.auth_status}</small>
        </div>
      ) : null}

      <div className="nt-divider" />
      <p className="nt-kicker">SENDER AVATARS</p>
      <div className="nt-form-grid nt-form-grid--single">
        <label className="nt-check">
          <input
            type="checkbox"
            checked={avatarSettings.remote_enabled}
            onChange={(event) =>
              setAvatarSettings((current) => ({
                ...current,
                remote_enabled: event.currentTarget.checked,
              }))
            }
          />
          Fetch remote sender avatars by default
        </label>
        <label className="nt-check">
          <input
            type="checkbox"
            checked={avatarSettings.bimi_enabled}
            onChange={(event) =>
              setAvatarSettings((current) => ({
                ...current,
                bimi_enabled: event.currentTarget.checked,
              }))
            }
          />
          Prefer BIMI logo records
        </label>
        <label className="nt-check">
          <input
            type="checkbox"
            checked={avatarSettings.favicon_enabled}
            onChange={(event) =>
              setAvatarSettings((current) => ({
                ...current,
                favicon_enabled: event.currentTarget.checked,
              }))
            }
          />
          Fallback to HTTPS favicon
        </label>
        <label className="nt-check">
          <input
            type="checkbox"
            checked={avatarSettings.auth_enabled}
            onChange={(event) =>
              setAvatarSettings((current) => ({
                ...current,
                auth_enabled: event.currentTarget.checked,
              }))
            }
          />
          Resolve SPF / DKIM / DMARC / BIMI signals
        </label>
      </div>
      <div className="nt-actions">
        <button
          type="button"
          className="nt-btn nt-btn--primary"
          onClick={() => void saveAvatarSettings()}
          disabled={busy}
        >
          Save avatar settings
        </button>
        <button
          type="button"
          className="nt-btn nt-btn--secondary"
          onClick={() => void clearSenderAvatarCache(false)}
          disabled={busy}
        >
          Clear remote cache
        </button>
        <button
          type="button"
          className="nt-btn nt-btn--secondary"
          onClick={() => void clearSenderAvatarCache(true)}
          disabled={busy}
        >
          Clear all avatars
        </button>
      </div>

      <div className="nt-divider" />
      <p className="nt-kicker">TEMP MAILBOX</p>
      <div className="nt-form-grid nt-form-grid--single">
        <label>
          Target service
          <input
            value={targetService}
            placeholder="github, openai, custom..."
            onChange={(event) => setTargetService(event.currentTarget.value)}
          />
        </label>
        <label>
          Note
          <input
            value={note}
            placeholder="Why this mailbox was created"
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        </label>
        <label className="nt-check">
          <input
            type="checkbox"
            checked={waitForCode}
            onChange={(event) => setWaitForCode(event.currentTarget.checked)}
          />
          Wait for code after creation
        </label>
      </div>
      <div className="nt-actions">
        <button type="button" className="nt-btn nt-btn--primary" onClick={createAndSelectTempMailbox} disabled={busy}>
          Create temp mailbox
        </button>
        <button type="button" className="nt-btn nt-btn--secondary" onClick={refreshAnonymousMail} disabled={busy}>
          Refresh anonymous
        </button>
      </div>
      <div className="nt-divider" />
      <p className="nt-kicker">RECOVER MAILBOX</p>
      <div className="nt-form-grid">
        <label>
          Email address
          <input
            value={tempRecoveryEmail}
            placeholder="mailbox@example.test"
            onChange={(event) => setTempRecoveryEmail(event.currentTarget.value)}
          />
        </label>
        <label>
          Provider type (optional)
          <input
            value={tempRecoveryProviderType}
            placeholder="mailtm, m2u..."
            onChange={(event) => setTempRecoveryProviderType(event.currentTarget.value)}
          />
        </label>
      </div>
      <div className="nt-actions">
        <button
          type="button"
          className="nt-btn nt-btn--secondary"
          onClick={() => void recoverTempMailbox()}
          disabled={busy}
        >
          Recover from local core
        </button>
      </div>
      <small>
        Recovery uses provider and mailbox state already held by the local core; credentials are not retained by this UI.
      </small>
      <div className="nt-divider" />
      <p className="nt-kicker">MAILBOX ACTIONS</p>
      <div className="nt-form-grid">
        <label className="nt-wide-field">
          Temporary mailbox
          <select
            value={selectedTempMailboxId}
            onChange={(event) => setSelectedTempMailboxId(event.currentTarget.value)}
          >
            <option value="">Select a mailbox</option>
            {tempMailboxes.map((mailbox) => (
              <option key={mailbox.id} value={mailbox.id}>
                {mailbox.email_address} ({mailbox.lifecycle_state})
              </option>
            ))}
          </select>
        </label>
        <label>
          Sender filter
          <input
            value={tempMailboxFromContains}
            placeholder="example.com; blank clears"
            onChange={(event) => setTempMailboxFromContains(event.currentTarget.value)}
          />
        </label>
        <label>
          Failure reason
          <input
            value={tempOutcomeFailureReason}
            placeholder="Rejected domain, provider error..."
            onChange={(event) => setTempOutcomeFailureReason(event.currentTarget.value)}
          />
        </label>
        <label>
          Send to
          <input
            value={tempSendTo}
            placeholder="recipient@example.test"
            onChange={(event) => setTempSendTo(event.currentTarget.value)}
          />
        </label>
        <label>
          Send subject
          <input
            value={tempSendSubject}
            placeholder="Message subject"
            onChange={(event) => setTempSendSubject(event.currentTarget.value)}
          />
        </label>
        <label className="nt-wide-field">
          Send body
          <textarea
            value={tempSendBody}
            placeholder="Plain-text message body"
            onChange={(event) => setTempSendBody(event.currentTarget.value)}
          />
        </label>
      </div>
      <div className="nt-actions">
        <button
          type="button"
          className="nt-btn nt-btn--secondary"
          onClick={() => void readTempMailboxAuthenticationLink()}
          disabled={busy || !selectedTempMailboxId}
        >
          Read auth link
        </button>
        <button
          type="button"
          className="nt-btn nt-btn--secondary"
          onClick={() => void updateTempMailboxSession()}
          disabled={busy || !selectedTempMailboxId}
        >
          Update sender filter
        </button>
        <button
          type="button"
          className="nt-btn nt-btn--secondary"
          onClick={() => void reportTempMailboxOutcome(true)}
          disabled={busy || !selectedTempMailboxId}
        >
          Report success
        </button>
        <button
          type="button"
          className="nt-btn nt-btn--secondary"
          onClick={() => void reportTempMailboxOutcome(false)}
          disabled={busy || !selectedTempMailboxId}
        >
          Report failure
        </button>
        <button
          type="button"
          className="nt-btn nt-btn--primary"
          onClick={() => void sendTempMailboxMessage()}
          disabled={busy || !selectedTempMailboxId}
        >
          Send from mailbox
        </button>
        <button
          type="button"
          className="nt-btn nt-btn--secondary"
          onClick={() => void releaseTempMailbox()}
          disabled={busy || !selectedTempMailboxId}
        >
          Release mailbox
        </button>
      </div>
      {lastAuthenticationLink ? (
        <div className="nt-result">
          <strong>Authentication link</strong>
          <span>{lastAuthenticationLink.label ?? "Detected action link"}</span>
          <small>{lastAuthenticationLink.url}</small>
          <button
            type="button"
            className="nt-mini-btn"
            onClick={() => void openLastTempMailboxAuthenticationLink()}
          >
            Open link
          </button>
        </div>
      ) : null}
      {lastRefresh ? (
        <div className="nt-result">
          <strong>Last refresh</strong>
          <span>
            fetched {lastRefresh.fetched_count}, inserted {lastRefresh.inserted_count},
            skipped {lastRefresh.skipped_count}, failed {lastRefresh.failed_count}
          </span>
          {lastRefresh.failures.length > 0 ? (
            <small>
              {lastRefresh.failures
                .map((failure) => `${failure.temp_mailbox_id}: ${failure.error_code}`)
                .join(", ")}
            </small>
          ) : null}
        </div>
      ) : null}
      {lastPromotion ? (
        <div className="nt-result">
          <strong>Last promotion</strong>
          <span>{lastPromotion.account.display_name} is now {lastPromotion.account.status}.</span>
        </div>
      ) : null}
      <div className="nt-scroll-pane nt-scroll-pane--short">
        {tempMailboxes.length > 0 ? (
          tempMailboxes.map((mailbox) => (
            <article className="nt-resource-row" key={mailbox.id}>
              <strong>{mailbox.email_address}</strong>
              <span>
                {mailbox.provider_label} / {mailbox.visibility_state} /{" "}
                {mailbox.lifecycle_state}
              </span>
              <small>{mailbox.easyemail_mailbox_id ?? "no EasyEmail session id"}</small>
              <div className="nt-row-actions">
                <button
                  type="button"
                  className="nt-mini-btn"
                  onClick={() => void refreshMailbox(mailbox.id)}
                  disabled={busy}
                >
                  Refresh
                </button>
                {mailbox.visibility_state === "anonymous" &&
                mailbox.easyemail_mailbox_id !== mailbox.id ? (
                  <button
                    type="button"
                    className="nt-mini-btn"
                    onClick={() => void promoteMailbox(mailbox)}
                    disabled={busy}
                  >
                    Promote
                  </button>
                ) : null}
              </div>
            </article>
          ))
        ) : (
          <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
            No temporary mailboxes yet.
          </p>
        )}
      </div>
    </section>
  );
}

import type { AppController } from "../../app/useAppController";

export function QueueWorkspace({ controller }: { controller: AppController }) {
  const {
    loadSendQueue, runSendQueueWorkerOnce, busy, selectedNormalAccountId, setSelectedNormalAccountId, setStatusMessage, sendEnabledAccounts, sendTargetAddress,
    setSendTargetAddress, sendSubject, setSendSubject, sendBodyText, setDraftBodyText, enqueueDraftSend, lastSend, lastSendWorkerRun,
    sendQueue,
  } = controller;
  return (
    <section className="nt-board-view">
      <div className="nt-board-head">
        <div>
          <p className="nt-kicker">SEND QUEUE</p>
          <h1>SMTP dispatch board</h1>
          <span>Outgoing mail is queued and processed by worker runs.</span>
        </div>
        <div className="nt-board-actions">
          <button type="button" className="nt-btn nt-btn--secondary" onClick={() => void loadSendQueue()}>
            Refresh queue
          </button>
          <button type="button" className="nt-btn nt-btn--secondary" onClick={() => void runSendQueueWorkerOnce()} disabled={busy}>
            Run worker
          </button>
        </div>
      </div>

      <div className="nt-two-column">
        <section className="nt-action-board">
          <div className="nt-form-grid nt-form-grid--single">
            <label>
              Sender account
              <select
                value={selectedNormalAccountId ?? ""}
                onChange={(event) => {
                  const accountId = event.currentTarget.value || null;
                  setSelectedNormalAccountId(accountId);
                  setStatusMessage("Canonical SMTP and message history become available in M5/M6.");
                }}
              >
                <option value="">Select send-enabled account</option>
                {sendEnabledAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.display_name} - {account.primary_address ?? account.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Target address
              <input
                value={sendTargetAddress}
                placeholder="target@example.com"
                onChange={(event) => setSendTargetAddress(event.currentTarget.value)}
              />
            </label>
            <label>
              Subject
              <input
                value={sendSubject}
                placeholder="Task or message subject"
                onChange={(event) => setSendSubject(event.currentTarget.value)}
              />
            </label>
            <label>
              Body
              <textarea
                value={sendBodyText}
                placeholder="Queued SMTP body"
                onChange={(event) => setDraftBodyText(event.currentTarget.value)}
              />
            </label>
          </div>
          <button type="button" className="nt-btn nt-btn--primary" onClick={() => void enqueueDraftSend()} disabled={busy}>
            Queue send
          </button>
          {lastSend ? (
            <div className="nt-result">
              <strong>Last queued send</strong>
              <span>
                Message {lastSend.message_id} entered queue {lastSend.queue_id} as{" "}
                {lastSend.status}.
              </span>
            </div>
          ) : null}
          {lastSendWorkerRun ? (
            <div className="nt-result">
              <strong>Last worker run</strong>
              <span>
                processed {lastSendWorkerRun.processed_count}, sent {lastSendWorkerRun.sent_count},
                retry {lastSendWorkerRun.retry_count}, failed {lastSendWorkerRun.failed_count}
              </span>
            </div>
          ) : null}
        </section>

        <section className="nt-list-pane nt-list-pane--wide">
          <div className="nt-pane-head">
            <p className="nt-kicker">QUEUE ITEMS</p>
            <span>{sendQueue.length}</span>
          </div>
          <div className="nt-scroll-pane">
            {sendQueue.length > 0 ? (
              sendQueue.map((item) => (
                <article className="nt-resource-row" key={item.id}>
                  <strong>{item.subject}</strong>
                  <span>To: {item.target_address}</span>
                  <small>
                    {item.status} / attempts {item.attempt_count} / {item.updated_at}
                  </small>
                </article>
              ))
            ) : (
              <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
                No send queue items yet.
              </p>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

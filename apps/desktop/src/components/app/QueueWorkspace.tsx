import type { AppController } from "../../app/useAppController";

const RETRYABLE_QUEUE_STATUSES = new Set([
  "failed",
  "auth_failed",
  "cancelled",
  "delivery_unknown",
]);

export function QueueWorkspace({ controller }: { controller: AppController }) {
  const {
    busy, selectedNormalAccountId, setSelectedNormalAccountId, sendEnabledAccounts, sendTargetAddress,
    setSendTargetAddress, sendSubject, setSendSubject, sendBodyText, setDraftBodyText, enqueueDraftSend,
    cancelSendQueueItem, retrySendQueueItem, lastSend, lastSendWorkerRun, sendQueueWorkerStatus, sendQueue,
  } = controller;
  return (
    <section className="nt-board-view nt-board-view--content-only">
      <div className="nt-two-column">
        <section className="nt-action-board">
          <div className="nt-form-grid nt-form-grid--single">
            <label>
              Sender account
              <select
                value={selectedNormalAccountId ?? ""}
                onChange={(event) => setSelectedNormalAccountId(event.currentTarget.value || null)}
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
          {sendQueueWorkerStatus ? (
            <div className="nt-result">
              <strong>Server worker</strong>
              <span>
                {sendQueueWorkerStatus.enabled ? "active" : "disabled"} ({sendQueueWorkerStatus.interval_ms}ms) /
                sent {sendQueueWorkerStatus.total_sent_count}, retry {sendQueueWorkerStatus.total_retry_count},
                failed {sendQueueWorkerStatus.total_failed_count}
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
                    {item.scheduled_at ? ` / scheduled ${item.scheduled_at}` : ""}
                  </small>
                  {item.last_error_message ? (
                    <small>{item.last_error_message}</small>
                  ) : null}
                  {item.status === "queued" || RETRYABLE_QUEUE_STATUSES.has(item.status) ? (
                    <div className="nt-row-actions">
                      {item.status === "queued" ? (
                        <button
                          type="button"
                          className="nt-mini-btn"
                          onClick={() => void cancelSendQueueItem(item)}
                          disabled={busy}
                        >
                          Cancel
                        </button>
                      ) : null}
                      {RETRYABLE_QUEUE_STATUSES.has(item.status) ? (
                        <button
                          type="button"
                          className="nt-mini-btn"
                          onClick={() => void retrySendQueueItem(item)}
                          disabled={busy}
                        >
                          Retry
                        </button>
                      ) : null}
                    </div>
                  ) : null}
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

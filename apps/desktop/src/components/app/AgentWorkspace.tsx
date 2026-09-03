import type { AppController } from "../../app/useAppController";

export function AgentWorkspace({ controller }: { controller: AppController }) {
  const {
    loadAgentThreads, setAgentWorkspace, agentThreads, needsAttentionThreads, selectedAgentService, agentServices, agentWorkspace, loadAgentThreadDetail,
    selectedAgentThreadDetail, selectedAgentSenderId, setSelectedAgentSenderId, sendEnabledAgentAccounts, selectedAgentServiceId, setSelectedAgentServiceId, agentTaskSubject, setAgentTaskSubject,
    agentTaskBody, setAgentTaskBody, confirmRestrictedAgent, setConfirmRestrictedAgent, sendAgentTask, busy, selectedAgentSender, lastAgentTask,
    agentAccounts, agentDisplayName, setAgentDisplayName, agentEmailAddress, setAgentEmailAddress, addAgentAccount, agentServiceName, setAgentServiceName,
    agentServiceEmail, setAgentServiceEmail, agentTrustLevel, setAgentTrustLevel, agentServiceDescription, setAgentServiceDescription, addAgentService,
  } = controller;
  return (
    <section className="nt-board-view">
      <div className="nt-board-head">
        <div>
          <p className="nt-kicker">AGENT MAIL</p>
          <h1>Task thread control</h1>
          <span>Agent accounts are scope=agent and hidden from normal Mail.</span>
        </div>
        <div className="nt-board-actions">
          <button type="button" className="nt-btn nt-btn--secondary" onClick={() => void loadAgentThreads()}>
            Refresh threads
          </button>
          <button
            type="button"
            className="nt-btn nt-btn--primary"
            onClick={() => setAgentWorkspace("compose")}
          >
            Compose task
          </button>
        </div>
      </div>

      <div className="nt-agent-layout">
        <aside className="nt-directory">
          <p className="nt-kicker">WORKSPACE</p>
          <div className="nt-source-list">
            {([
              ["threads", "Threads", `${agentThreads.length}`],
              ["attention", "Needs attention", `${needsAttentionThreads.length}`],
              ["compose", "Compose", selectedAgentService?.trust_level ?? "target"],
              ["services", "Services", `${agentServices.length}`],
            ] as const).map(([id, label, meta]) => (
              <button
                type="button"
                key={id}
                className={`nt-source-card ${agentWorkspace === id ? "nt-source-card--active" : ""}`}
                onClick={() => setAgentWorkspace(id)}
              >
                <strong>{label}</strong>
                <span>{meta}</span>
              </button>
            ))}
          </div>
          <div className="nt-divider" />
          <span className="nt-badge nt-badge--signal">scope=agent</span>
          <span className="nt-badge nt-badge--cyan">remote services are not accounts</span>
        </aside>

        {agentWorkspace === "threads" || agentWorkspace === "attention" ? (
          <>
            <section className="nt-list-pane">
              <div className="nt-pane-head">
                <p className="nt-kicker">
                  {agentWorkspace === "attention" ? "UNMATCHED" : "THREADS"}
                </p>
                <span>
                  {agentWorkspace === "attention"
                    ? needsAttentionThreads.length
                    : agentThreads.length}
                </span>
              </div>
              <div className="nt-scroll-pane">
                {(agentWorkspace === "attention" ? needsAttentionThreads : agentThreads).length > 0 ? (
                  (agentWorkspace === "attention" ? needsAttentionThreads : agentThreads).map((thread) => (
                    <button
                      type="button"
                      className="nt-thread-card"
                      key={thread.id}
                      onClick={() => void loadAgentThreadDetail(thread.id)}
                    >
                      <strong>{thread.subject}</strong>
                      <span>{thread.correlation_key}</span>
                      <small>{thread.status}</small>
                    </button>
                  ))
                ) : (
                  <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
                    No Agent threads in this lane.
                  </p>
                )}
              </div>
            </section>

            <article className="nt-reading-pane nt-reading-pane--dark">
              <p className="nt-kicker">THREAD DETAIL</p>
              {selectedAgentThreadDetail ? (
                <>
                  <h2>{selectedAgentThreadDetail.thread.subject}</h2>
                  <div className="nt-meta-grid">
                    <span>Status</span>
                    <strong>{selectedAgentThreadDetail.thread.status}</strong>
                    <span>Service</span>
                    <strong>{selectedAgentThreadDetail.thread.agent_service_id}</strong>
                    <span>Sender</span>
                    <strong>{selectedAgentThreadDetail.thread.sender_account_id}</strong>
                  </div>
                  <div className="nt-timeline">
                    {selectedAgentThreadDetail.messages.map((message) => (
                      <article className="nt-timeline-item" key={message.id}>
                        <span>{message.direction}</span>
                        <div>
                          <strong>{message.semantic_role}</strong>
                          <small>
                            {message.parsed_status ?? "unknown"} / {message.created_at}
                          </small>
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              ) : (
                <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
                  Open a thread to inspect outgoing task mail and replies.
                </p>
              )}
            </article>
          </>
        ) : null}

        {agentWorkspace === "compose" ? (
          <section className="nt-action-board">
            <div className="nt-form-grid">
              <label>
                Task sender
                <select
                  value={selectedAgentSenderId ?? ""}
                  onChange={(event) => setSelectedAgentSenderId(event.currentTarget.value || null)}
                >
                  <option value="">Select send-enabled Agent account</option>
                  {sendEnabledAgentAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.display_name} - {account.primary_address ?? account.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Remote Agent service
                <select
                  value={selectedAgentServiceId ?? ""}
                  onChange={(event) => setSelectedAgentServiceId(event.currentTarget.value || null)}
                >
                  <option value="">Select remote Agent service</option>
                  {agentServices.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.display_name} - {service.trust_level}
                    </option>
                  ))}
                </select>
              </label>
              <label className="nt-wide-field">
                Task subject
                <input
                  value={agentTaskSubject}
                  placeholder="Research task"
                  onChange={(event) => setAgentTaskSubject(event.currentTarget.value)}
                />
              </label>
              <label className="nt-wide-field">
                Task body
                <textarea
                  value={agentTaskBody}
                  placeholder="Describe the task for the remote Agent"
                  onChange={(event) => setAgentTaskBody(event.currentTarget.value)}
                />
              </label>
              <label className="nt-check">
                <input
                  type="checkbox"
                  checked={confirmRestrictedAgent}
                  onChange={(event) => setConfirmRestrictedAgent(event.currentTarget.checked)}
                />
                Confirm restricted service send
              </label>
            </div>
            <div className="nt-actions">
              <button type="button" className="nt-btn nt-btn--primary" onClick={() => void sendAgentTask()} disabled={busy}>
                Queue Agent task
              </button>
              <span className="nt-badge nt-badge--signal">
                {selectedAgentService?.trust_level ?? "no service"}
              </span>
              <span className="nt-badge nt-badge--cyan">
                {selectedAgentSender?.primary_address ?? "no sender"}
              </span>
            </div>
            {lastAgentTask ? (
              <div className="nt-result">
                <strong>Last Agent task</strong>
                <span>
                  Thread {lastAgentTask.thread.id} is {lastAgentTask.thread.status}; queue{" "}
                  {lastAgentTask.queue_id} is {lastAgentTask.queue_status}.
                </span>
              </div>
            ) : null}
          </section>
        ) : null}

        {agentWorkspace === "services" ? (
          <section className="nt-action-board nt-action-board--split">
            <div>
              <p className="nt-kicker">MY AGENT MAILBOXES</p>
              <div className="nt-scroll-pane nt-scroll-pane--short">
                {agentAccounts.length > 0 ? (
                  agentAccounts.map((account) => (
                    <article className="nt-resource-row" key={account.id}>
                      <strong>{account.display_name}</strong>
                      <span>{account.primary_address ?? "No address"}</span>
                      <small>
                        {account.scope} / {account.send_status} / hidden{" "}
                        {account.listed_in_all_accounts ? "no" : "yes"}
                      </small>
                    </article>
                  ))
                ) : (
                  <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
                    No Agent sender accounts yet.
                  </p>
                )}
              </div>
              <div className="nt-form-grid nt-form-grid--single">
                <label>
                  Agent account name
                  <input
                    value={agentDisplayName}
                    placeholder="Agent Sender"
                    onChange={(event) => setAgentDisplayName(event.currentTarget.value)}
                  />
                </label>
                <label>
                  Agent account email
                  <input
                    value={agentEmailAddress}
                    placeholder="agent@example.com"
                    onChange={(event) => setAgentEmailAddress(event.currentTarget.value)}
                  />
                </label>
                <button type="button" className="nt-btn nt-btn--secondary" onClick={() => void addAgentAccount()} disabled={busy}>
                  Add Agent account
                </button>
              </div>
            </div>

            <div>
              <p className="nt-kicker">REMOTE SERVICES</p>
              <div className="nt-scroll-pane nt-scroll-pane--short">
                {agentServices.length > 0 ? (
                  agentServices.map((service) => (
                    <article className="nt-resource-row" key={service.id}>
                      <strong>{service.display_name}</strong>
                      <span>{service.email_address}</span>
                      <small>{service.trust_level} / {service.status}</small>
                    </article>
                  ))
                ) : (
                  <p className="nt-empty" role="status" aria-live="polite" data-empty-state>
                    No remote Agent services yet.
                  </p>
                )}
              </div>
              <div className="nt-form-grid nt-form-grid--single">
                <label>
                  Service name
                  <input
                    value={agentServiceName}
                    placeholder="Remote Agent"
                    onChange={(event) => setAgentServiceName(event.currentTarget.value)}
                  />
                </label>
                <label>
                  Service email
                  <input
                    value={agentServiceEmail}
                    placeholder="remote-agent@example.com"
                    onChange={(event) => setAgentServiceEmail(event.currentTarget.value)}
                  />
                </label>
                <label>
                  Trust level
                  <select
                    value={agentTrustLevel}
                    onChange={(event) => setAgentTrustLevel(event.currentTarget.value)}
                  >
                    <option value="trusted">trusted</option>
                    <option value="restricted">restricted</option>
                    <option value="blocked">blocked</option>
                    <option value="unknown">unknown</option>
                  </select>
                </label>
                <label>
                  Description
                  <textarea
                    value={agentServiceDescription}
                    placeholder="What this Agent service is allowed to handle"
                    onChange={(event) => setAgentServiceDescription(event.currentTarget.value)}
                  />
                </label>
                <button type="button" className="nt-btn nt-btn--primary" onClick={() => void addAgentService()} disabled={busy}>
                  Add remote service
                </button>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
}

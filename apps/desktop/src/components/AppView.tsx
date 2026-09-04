import type { AppController } from "../app/useAppController";

import { AgentWorkspace } from "./app/AgentWorkspace";
import { AppOverlays } from "./app/AppOverlays";
import { ComposeOverlays } from "./app/ComposeOverlays";
import { EasyEmailSetupPanel } from "./app/EasyEmailSetupPanel";
import { MailAccountSetupPanel } from "./app/MailAccountSetupPanel";
import { MailWorkspace } from "./app/MailWorkspace";
import { QueueWorkspace } from "./app/QueueWorkspace";
import { SideRail } from "./app/SideRail";

export function AppView({ controller }: { controller: AppController }) {
  const {
    activeView,
    railCollapsed,
    busy,
    toastMessage,
    toastKey,
    toastVisibleKey,
    error,
    copyToast,
    composePopoverOpen,
    toastFading,
    dismissCurrentToast,
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
      <AppOverlays controller={controller} />
      <ComposeOverlays controller={controller} />
      <SideRail controller={controller} />

      <section className="nt-workspace-board">
        {activeView === "mail" ? <MailWorkspace controller={controller} /> : null}

        {activeView === "agent" ? <AgentWorkspace controller={controller} /> : null}

        {activeView === "queue" ? <QueueWorkspace controller={controller} /> : null}

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
            {error?.correlation_id ? <small>关联 ID: {error.correlation_id}</small> : null}
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

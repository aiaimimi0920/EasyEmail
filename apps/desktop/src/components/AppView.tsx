import type { AppController } from "../app/useAppController";

import { AgentWorkspace } from "./app/AgentWorkspace";
import { AppOverlays } from "./app/AppOverlays";
import { ComposeOverlays } from "./app/ComposeOverlays";
import { DesktopChrome, WorkspacePageHeader } from "./app/DesktopChrome";
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
      <DesktopChrome />

      <section
        className={`nt-workspace-board ${
          activeView === "setup" ? "nt-workspace-board--settings" : ""
        }`}
      >
        {activeView !== "setup" ? <WorkspacePageHeader controller={controller} /> : null}
        {activeView === "mail" ? <MailWorkspace controller={controller} /> : null}

        {activeView === "agent" ? <AgentWorkspace controller={controller} /> : null}

        {activeView === "queue" ? <QueueWorkspace controller={controller} /> : null}

        {activeView === "setup" ? (
          <section className="nt-board-view nt-settings-page">
            <header className="nt-settings-page__heading">
              <h1>设置</h1>
            </header>

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

import { getCurrentWindow } from "@tauri-apps/api/window";

import type { AppController } from "../../app/useAppController";

type WindowCommand = "minimize" | "toggle-maximize" | "close";
type WindowIconKind = "minimize" | "maximize" | "close";

function WindowIcon({ kind }: { kind: WindowIconKind }) {
  if (kind === "minimize") {
    return (
      <svg aria-hidden="true" viewBox="0 0 18 18">
        <path d="M4 12.5h10" />
      </svg>
    );
  }
  if (kind === "maximize") {
    return (
      <svg aria-hidden="true" viewBox="0 0 18 18">
        <rect x="4.5" y="4.5" width="9" height="9" rx="0.5" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18">
      <path d="m5 5 8 8M13 5l-8 8" />
    </svg>
  );
}

async function runWindowCommand(command: WindowCommand) {
  try {
    const currentWindow = getCurrentWindow();
    if (command === "minimize") await currentWindow.minimize();
    if (command === "toggle-maximize") await currentWindow.toggleMaximize();
    if (command === "close") await currentWindow.close();
  } catch {
    // Browser previews do not expose a native Tauri window.
  }
}

export function DesktopChrome() {
  return (
    <header className="nt-app-titlebar">
      <div
        className="nt-app-titlebar__drag-region"
        data-tauri-drag-region
        onDoubleClick={() => void runWindowCommand("toggle-maximize")}
      />
      <div className="nt-app-titlebar__controls" aria-label="窗口控制">
        <button
          type="button"
          className="nt-window-control"
          aria-label="最小化"
          title="最小化"
          onClick={() => void runWindowCommand("minimize")}
        >
          <WindowIcon kind="minimize" />
        </button>
        <button
          type="button"
          className="nt-window-control"
          aria-label="最大化或还原"
          title="最大化或还原"
          onClick={() => void runWindowCommand("toggle-maximize")}
        >
          <WindowIcon kind="maximize" />
        </button>
        <button
          type="button"
          className="nt-window-control nt-window-control--close"
          aria-label="关闭"
          title="关闭"
          onClick={() => void runWindowCommand("close")}
        >
          <WindowIcon kind="close" />
        </button>
      </div>
    </header>
  );
}

export function WorkspacePageHeader({ controller }: { controller: AppController }) {
  const {
    activeView,
    onlyCodes,
    selectedMailboxLabel,
    loadAgentThreads,
    setAgentWorkspace,
    loadSendQueue,
    runSendQueueWorkerOnce,
    busy,
  } = controller;
  const pageTitle =
    activeView === "mail"
      ? onlyCodes
        ? "CODES"
        : selectedMailboxLabel
      : activeView === "agent"
        ? "代理邮件"
        : activeView === "queue"
          ? "发送队列"
          : "设置";

  return (
    <header className="nt-workspace-page-header" data-page={activeView}>
      <h1>{pageTitle}</h1>
      {activeView === "agent" ? (
        <div className="nt-board-actions nt-workspace-page-header__actions">
          <button type="button" className="nt-btn nt-btn--secondary" onClick={() => void loadAgentThreads()}>
            刷新
          </button>
          <button type="button" className="nt-btn nt-btn--primary" onClick={() => setAgentWorkspace("compose")}>
            新建任务
          </button>
        </div>
      ) : null}
      {activeView === "queue" ? (
        <div className="nt-board-actions nt-workspace-page-header__actions">
          <button type="button" className="nt-btn nt-btn--secondary" onClick={() => void loadSendQueue()}>
            刷新
          </button>
          <button type="button" className="nt-btn nt-btn--secondary" onClick={() => void runSendQueueWorkerOnce()} disabled={busy}>
            运行队列
          </button>
        </div>
      ) : null}
    </header>
  );
}

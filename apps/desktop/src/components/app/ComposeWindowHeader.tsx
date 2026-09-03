import type { AppController } from "../../app/useAppController";

export function ComposeWindowHeader({ controller }: { controller: AppController }) {
  const {
    composePopoverMinimized, setComposePopoverMinimized, sendSubject, composePopoverExpanded, setComposePopoverExpanded, closeComposePopover,
  } = controller;
  return (
    <header className="nt-compose-popover__titlebar">
      <button
        type="button"
        className="nt-compose-popover__grabber"
        aria-label={composePopoverMinimized ? "恢复写信窗口" : "写信窗口"}
        onClick={() => setComposePopoverMinimized(false)}
      >
        <span aria-hidden="true">⋮⋮</span>
      </button>
      <strong>{sendSubject.trim() || "写邮件"}</strong>
      <div className="nt-compose-popover__window-controls">
        <button
          type="button"
          aria-label="最小化写信窗口"
          onClick={() => setComposePopoverMinimized(true)}
        >
          −
        </button>
        <button
          type="button"
          aria-label={composePopoverExpanded ? "恢复写信窗口大小" : "展开写信窗口"}
          aria-expanded={composePopoverExpanded}
          onClick={() => {
            setComposePopoverMinimized(false);
            setComposePopoverExpanded((value) => !value);
          }}
        >
          ↗
        </button>
        <button
          type="button"
          aria-label="关闭写信窗口"
          onClick={closeComposePopover}
        >
          ×
        </button>
      </div>
    </header>
  );
}

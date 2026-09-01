type RailIconKind =
  | "mail"
  | "agent"
  | "queue"
  | "setup"
  | "grid"
  | "compose"
  | "inbox"
  | "drafts"
  | "sent"
  | "starred"
  | "archive"
  | "spam"
  | "trash"
  | "all-mail"
  | "newsletters"
  | "folders"
  | "labels";

type MailListToolbarIconKind =
  | "chevron-down"
  | "more"
  | "filter"
  | "chevron-left"
  | "chevron-right"
  | "mark-read"
  | "trash"
  | "archive"
  | "spam"
  | "nospam"
  | "inbox"
  | "delete"
  | "move"
  | "label"
  | "clock";

export function EasyEmailAppIcon() {
  return (
    <svg className="nt-app-icon nt-app-icon-signal-envelope" aria-hidden="true" viewBox="0 0 64 64">
      <defs>
        <linearGradient id="nt-app-icon-s2-bg" x1="5" y1="4" x2="59" y2="60">
          <stop offset="0" stopColor="var(--nt-surface-control-hover)" />
          <stop offset="1" stopColor="var(--nt-surface-app)" />
        </linearGradient>
        <linearGradient id="nt-app-icon-s2-mail" x1="10" y1="17" x2="54" y2="49">
          <stop offset="0" stopColor="var(--nt-action-primary)" />
          <stop offset="1" stopColor="var(--nt-action-primary-hover)" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="17" fill="url(#nt-app-icon-s2-bg)" />
      <path
        d="M12 19h40c2.2 0 4 1.8 4 4v22c0 2.2-1.8 4-4 4H12c-2.2 0-4-1.8-4-4V23c0-2.2 1.8-4 4-4Z"
        fill="url(#nt-app-icon-s2-mail)"
      />
      <path
        d="M10 22 32 39 54 22"
        fill="none"
        stroke="var(--nt-surface-rail)"
        strokeOpacity="0.64"
        strokeWidth="4.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 46 26 34M54 46 38 34"
        fill="none"
        stroke="var(--nt-surface-rail)"
        strokeOpacity="0.3"
        strokeWidth="3.4"
        strokeLinecap="round"
      />
      <path
        d="M18 15h18"
        stroke="var(--nt-action-info)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ClearFormatIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="17"
      height="17"
      data-icon="clear-format-eraser"
    >
      <path
        d="M15.7 4.4 21 9.7 12.9 17.8H7.6L3 13.2l8.1-8.1a3.25 3.25 0 0 1 4.6-.7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m9.2 7 7.6 7.6M6.8 17.8H21"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function RailIcon({ kind }: { kind: RailIconKind }) {
  if (kind === "grid") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
      </svg>
    );
  }

  if (kind === "compose") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" data-icon="compose-pencil">
        <path d="M5 19h4l10-10-4-4L5 15z" />
        <path d="m14 6 4 4M5 19l3-1" />
      </svg>
    );
  }

  if (kind === "inbox") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" data-icon="inbox-tray">
        <path d="M5 20h14l2-7h-5l-2 3h-4l-2-3H3z" />
        <path d="M7 13V5h10v8" />
      </svg>
    );
  }

  if (kind === "drafts") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" data-icon="draft-document">
        <path d="M7 4h7l4 4v12H7z" />
        <path d="M14 4v4h4M9.5 13h5M9.5 16h4" />
      </svg>
    );
  }

  if (kind === "sent") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" data-icon="sent-paper-plane">
        <path d="m4 12 16-7-5 15-3-6z" />
        <path d="m12 14 3-4" />
      </svg>
    );
  }

  if (kind === "starred") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" data-icon="starred-star">
        <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6-5.4-2.9-5.4 2.9 1-6-4.4-4.3 6.1-.9z" />
      </svg>
    );
  }

  if (kind === "archive") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" data-icon="archive-box">
        <path d="M4 7h16v4H4zM6 11h12v8H6z" />
        <path d="M10 14h4" />
      </svg>
    );
  }

  if (kind === "spam") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" data-icon="spam-flame">
        <path d="M12 21c3.3 0 6-2.5 6-5.8 0-3.8-3.4-6.4-4.3-10.2-2.8 1.7-2.1 5-5.1 7.1A4.9 4.9 0 0 0 6 16.1C6 19 8.7 21 12 21Z" />
        <path d="M12 18c1.3 0 2.4-.9 2.4-2.3 0-1.5-1.2-2.5-1.7-3.8-1.1.8-.9 2.1-2.1 3-.6.4-1 1-1 1.8 0 1.1 1.1 1.3 2.4 1.3Z" />
      </svg>
    );
  }

  if (kind === "trash") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" data-icon="trash-bin">
        <path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13" />
        <path d="M10 11v5M14 11v5" />
      </svg>
    );
  }

  if (kind === "all-mail") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" data-icon="all-mail-envelope">
        <path d="M4 7h16v11H4z" />
        <path d="m4 8 8 5 8-5M7 5h10" />
      </svg>
    );
  }

  if (kind === "newsletters") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" data-icon="newsletter-mail">
        <path d="M4 6h16v12H4z" />
        <path d="M7 10h5M7 13h8M7 16h4M16 10h1" />
      </svg>
    );
  }

  if (kind === "folders") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" data-icon="folder-outline">
        <path d="M4 7h6l2 2h8v9H4z" />
      </svg>
    );
  }

  if (kind === "labels") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" data-icon="tag-outline">
        <path d="M4 12 12 4h7v7l-8 8z" />
        <path d="M16 8h.01" />
      </svg>
    );
  }

  if (kind === "agent") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M6 8h12v7a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4z" />
        <path d="M9 8V5h6v3M9 13h.01M15 13h.01M10 16h4" />
      </svg>
    );
  }

  if (kind === "queue") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M5 7h14M5 12h14M5 17h10" />
        <path d="M17 15l2 2-2 2" />
      </svg>
    );
  }

  if (kind === "setup") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" data-icon="settings-gear">
        <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
        <path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.31 7.31 0 0 0-1.69-.98l-.39-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.49.42l-.39 2.65c-.6.24-1.17.57-1.69.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65a7.93 7.93 0 0 0 0 1.96l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.52.4 1.09.73 1.69.98l.39 2.65a.5.5 0 0 0 .49.42h4a.5.5 0 0 0 .49-.42l.39-2.65c.6-.24 1.17-.57 1.69-.98l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65Z" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 6h16v12H4z" />
      <path d="m4 7 8 6 8-6" />
    </svg>
  );
}

export function RailChevronIcon({ direction }: { direction: "left" | "right" }) {
  const points = direction === "right" ? "6 3.5 10 8 6 12.5" : "10 3.5 6 8 10 12.5";

  return (
    <svg className="nt-rail-chevron" aria-hidden="true" viewBox="0 0 16 16">
      <polyline points={points} />
    </svg>
  );
}

export function SearchMagnifierIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="m12.6 12.6 4.1 4.1" />
    </svg>
  );
}

export function MailListToolbarIcon({ kind }: { kind: MailListToolbarIconKind }) {
  switch (kind) {
    case "chevron-down":
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="m5 7 5 6 5-6" />
        </svg>
      );
    case "more":
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="M4 10h.01M10 10h.01M16 10h.01" />
        </svg>
      );
    case "filter":
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="M3 5h14M6 10h8m-5 5h2" />
        </svg>
      );
    case "mark-read":
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="M3.5 6.5h13v8h-13z" />
          <path d="m4 7 6 4.5L16 7" />
        </svg>
      );
    case "trash":
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="M4 6h12" />
          <path d="M8 6V4.5h4V6" />
          <path d="M6 7.5 6.7 16h6.6l.7-8.5" />
          <path d="M8.5 9.5v4M11.5 9.5v4" />
        </svg>
      );
    case "archive":
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="M4 5h12v3H4z" />
          <path d="M5.5 8v7h9V8" />
          <path d="M8 11h4" />
        </svg>
      );
    case "spam":
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="M10 3.5c2.2 2.1.7 3.5 2.7 5.3.8.7 1.3 1.7 1.3 2.9A4 4 0 0 1 6 12c0-1.7 1-2.8 2.1-4 .8-.9 1.7-2 1.9-4.5Z" />
          <path d="M8.2 13.2c0 1 .8 1.8 1.8 1.8s1.8-.8 1.8-1.8c0-.8-.5-1.4-1.2-2-.5-.4-.6-.8-.6-1.4-.8.7-1.8 1.8-1.8 3.4Z" />
        </svg>
      );
    case "nospam":
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="M10 3.5c2.2 2.1.7 3.5 2.7 5.3.8.7 1.3 1.7 1.3 2.9A4 4 0 0 1 6 12c0-1.7 1-2.8 2.1-4 .8-.9 1.7-2 1.9-4.5Z" />
          <path d="M5 15 15 5" />
        </svg>
      );
    case "inbox":
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="M4 5.5h12l1 9H3z" />
          <path d="M4.8 11.5h2.7l1.2 2h2.6l1.2-2h2.7" />
        </svg>
      );
    case "delete":
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="M5 5 15 15M15 5 5 15" />
          <path d="M4 3.5h12v13H4z" />
        </svg>
      );
    case "move":
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="M3.5 6.5h5l1.3 1.5h6.7v7.5h-13z" />
          <path d="M11 11h4m-1.5-1.5L15 11l-1.5 1.5" />
        </svg>
      );
    case "label":
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="M4 5.5h7l5 5-5 5H4z" />
          <path d="M7.5 9h.01" />
        </svg>
      );
    case "clock":
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="6.5" />
          <path d="M10 6.5V10l2.5 1.5" />
        </svg>
      );
    case "chevron-left":
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="m12 5-5 5 5 5" />
        </svg>
      );
    case "chevron-right":
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="m8 5 5 5-5 5" />
        </svg>
      );
    default:
      return null;
  }
}

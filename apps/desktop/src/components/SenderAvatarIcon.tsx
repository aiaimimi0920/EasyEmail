import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { useMemo } from "react";

import {
  resolveSenderAvatarPresentation,
  type SenderAvatarDto,
  type SenderAvatarKind,
} from "../mail/senderAvatar";

export type { SenderAvatarDto } from "../mail/senderAvatar";

const senderAvatarClassByKind: Record<SenderAvatarKind, string> = {
  "qq-mail": "nt-sender-avatar--qq-mail",
  openai: "nt-sender-avatar--openai",
  "railway-12306": "nt-sender-avatar--railway-12306",
  github: "nt-sender-avatar--github",
  google: "nt-sender-avatar--google",
  generic: "nt-sender-avatar--generic",
};

export function SenderAvatarIcon({
  value,
  avatar: remoteAvatar,
  compact = false,
  onAvatarClick,
}: {
  value: string;
  avatar?: SenderAvatarDto | null;
  compact?: boolean;
  onAvatarClick?: (sender: string, target: HTMLElement) => void;
}) {
  const avatar = useMemo(
    () => resolveSenderAvatarPresentation(value, remoteAvatar),
    [remoteAvatar, value],
  );
  const handleClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (!onAvatarClick) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onAvatarClick(value, event.currentTarget);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!onAvatarClick) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      onAvatarClick(value, event.currentTarget);
    }
  };

  return (
    <span
      className={`nt-sender-avatar ${senderAvatarClassByKind[avatar.kind]} ${
        compact ? "nt-sender-avatar--compact" : ""
      }`}
      title={avatar.title}
      aria-label={avatar.label}
      role={onAvatarClick ? "button" : undefined}
      tabIndex={onAvatarClick ? 0 : undefined}
      aria-haspopup={onAvatarClick ? "dialog" : undefined}
      data-avatar-source={remoteAvatar?.source_kind ?? "local"}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {remoteAvatar?.image_data_url ? (
        <img className="nt-sender-avatar__image" src={remoteAvatar.image_data_url} alt="" />
      ) : (
        <span className="nt-sender-avatar__fallback">{avatar.fallback}</span>
      )}
    </span>
  );
}

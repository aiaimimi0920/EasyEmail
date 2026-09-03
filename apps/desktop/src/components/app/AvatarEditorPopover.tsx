import type { AppController } from "../../app/useAppController";

export function AvatarEditorPopover({ controller }: { controller: AppController }) {
  const {
    avatarEditor, SenderAvatarIcon, avatarEditorAvatar, displayNameFromAddress, extractEmailAddress, chooseAvatarEditorFile, busy, clearAvatarEditorContact,
    avatarEditorHasCustomIcon, setAvatarEditor,
  } = controller;
  if (!avatarEditor) return null;
  return (
    <div
      className="nt-avatar-popover"
      role="dialog"
      aria-label="发件人图标编辑器"
      data-nonmodal-layer="avatar-editor"
      style={{ left: avatarEditor.left, top: avatarEditor.top }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="nt-avatar-popover__head">
        <SenderAvatarIcon value={avatarEditor.sender} avatar={avatarEditorAvatar} />
        <div>
          <strong>{displayNameFromAddress(avatarEditor.sender)}</strong>
          <span>{extractEmailAddress(avatarEditor.sender)}</span>
        </div>
      </div>
      <div className="nt-avatar-popover__actions">
        <button type="button" onClick={chooseAvatarEditorFile} disabled={busy}>
          Upload custom icon
        </button>
        <button
          type="button"
          onClick={() => void clearAvatarEditorContact()}
          disabled={busy || !avatarEditorHasCustomIcon}
        >
          Clear custom icon
        </button>
      </div>
      <button
        type="button"
        className="nt-avatar-popover__close"
        onClick={() => setAvatarEditor(null)}
      >
        Close
      </button>
    </div>
  );
}

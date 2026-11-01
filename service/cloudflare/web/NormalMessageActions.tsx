import type { NormalMailSummary } from "./normal-inbox";
import { useNormalOrganization } from "./NormalOrganization";

export function NormalMessageActions({ message, disabled = false }: { message: NormalMailSummary; disabled?: boolean }) {
  const action = useNormalOrganization(), state = message.platformState, locked = disabled || action.locked;
  const submit = (patch: Parameters<typeof action.submit>[2]) => action.submit(message.accountId, [message.id], patch, message.serverFolderId);
  return <section aria-label="普通邮件整理"><div className="row">
    <button className="secondary" disabled={locked} onClick={() => void submit({ isRead: !state.isRead })}>{state.isRead ? "标为未读" : "标为已读"}</button>
    <button className="secondary" disabled={locked} onClick={() => void submit({ starred: !state.starred })}>{state.starred ? "取消星标" : "加星标"}</button>
    <button className="secondary" disabled={locked} onClick={() => void submit({ archived: !state.archived })}>{state.archived ? "移回收件箱" : "归档"}</button>
    <button className={state.trashedAt === null ? "danger" : "secondary"} disabled={locked} onClick={() => {
      if (state.trashedAt !== null || window.confirm("移到平台回收站？不会删除服务器上的邮件。")) {
        void submit({ trashed: state.trashedAt === null });
      }
    }}>{state.trashedAt === null ? "移到平台回收站" : "恢复平台邮件"}</button>
  </div></section>;
}

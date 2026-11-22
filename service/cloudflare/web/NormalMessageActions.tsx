import { useConfirmation } from "./Confirmation";
import { Button } from '@neuro/ui';
import type { NormalMailSummary } from "./normal-inbox";
import { useNormalOrganization } from "./NormalOrganization";

export function NormalMessageActions({ message, disabled = false }: { message: NormalMailSummary; disabled?: boolean }) {
  const action = useNormalOrganization(), state = message.platformState, locked = disabled || action.locked;
  const submit = (patch: Parameters<typeof action.submit>[2]) => action.submit(message.accountId, [message.id], patch, message.serverFolderId);
  const confirm = useConfirmation([message, locked]);
  return <section aria-label="普通邮件整理"><div className="row">
    <Button disabled={locked} onClick={() => void submit({ isRead: !state.isRead })} variant="quiet" wrap>{state.isRead ? "标为未读" : "标为已读"}</Button>
    <Button disabled={locked} onClick={() => void submit({ starred: !state.starred })} variant="quiet" wrap>{state.starred ? "取消星标" : "加星标"}</Button>
    <Button disabled={locked} onClick={() => void submit({ archived: !state.archived })} variant="quiet" wrap>{state.archived ? "移回收件箱" : "归档"}</Button>
    <Button variant={state.trashedAt === null ? "danger" : "quiet"} disabled={locked} onClick={async () => {
      if (state.trashedAt !== null || (await confirm("移到平台回收站？不会删除服务器上的邮件。"))) {
        void submit({ trashed: state.trashedAt === null });
      }
    }} wrap>{state.trashedAt === null ? "移到平台回收站" : "恢复平台邮件"}</Button>
  </div></section>;
}

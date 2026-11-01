import { dateText } from "./api";
import { normalMessagePath, type NormalMail } from "./normal-inbox";
import { NormalCachedMessage } from "./NormalCachedMessage";
import { NormalMessageActions } from "./NormalMessageActions";
import { MessageLabels } from "./MessageLabels";
import { MessageFolder } from "./MessageFolder";
import { useNormalOrganization } from "./NormalOrganization";
import type { TaxonomyController } from "./labels-api";
import { NormalReplyButton } from "./NormalReply";
import { NormalRemoteFlagActions } from "./NormalRemoteFlagActions";
import { NormalRemoteMutationActions } from "./NormalRemoteMutationActions";
import { useNormalMutationRecord } from "./useNormalMutationRecord";

export function NormalMessageContent({ message, disabled = false }: { message: NormalMail; disabled?: boolean }) {
  const path = normalMessagePath(message);
  const mutation = useNormalMutationRecord(message);
  const action = useNormalOrganization(), controller: TaxonomyController = { locked: disabled || action.locked, revision: action.revision,
    submit: (ids, patch) => action.submit(message.accountId, ids, patch, message.serverFolderId) };
  return <section aria-label="普通邮件详情"><h4>{message.subject || "（无主题）"}</h4><p>{message.sender} → {message.recipient}</p>
    <p>{dateText(message.receivedAt)} · UID {message.uid}{message.serverFolderId ? ` · ${message.serverFolderName || "服务器文件夹"}` : ""}</p>
    <NormalMessageActions message={message} disabled={disabled} />
    <NormalRemoteFlagActions key={`${path}:remote`} message={message} disabled={disabled || mutation.locked} />
    <NormalRemoteMutationActions key={`${path}:${message.epochId}:${message.accountRevision}:mutation`} message={message} record={mutation} disabled={disabled} />
    <NormalReplyButton accountId={message.accountId} messageId={message.id} serverFolderId={message.serverFolderId}
      disabled={disabled || message.platformState.trashedAt !== null} />
    <NormalCachedMessage path={path} message={message} />
    <MessageLabels key={`labels:${path}`} path={path} id={message.id} controller={controller} />
    <MessageFolder key={`folder:${path}`} path={path} id={message.id} controller={controller} />
  </section>;
}

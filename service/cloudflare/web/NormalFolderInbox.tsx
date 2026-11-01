import { useEffect, useState } from "react";
import { errorMessage } from "./api";
import type { NormalAccount } from "./normal-accounts";
import type { ServerFolder } from "./normal-server-folders";
import { useNormalInbox } from "./useNormalInbox";
import { NormalMessageContent } from "./NormalMessageContent";
import { NormalInboxMessages } from "./NormalInboxMessages";
import { useNormalOrganization } from "./NormalOrganization";
import { loadLabels, type Label } from "./labels-api";
import { loadFolders, type Folder } from "./folders-api";
import { useNormalRemoteFlags } from "./NormalRemoteFlags";

export function NormalFolderInbox({ account, folder, visible, disabled, onBusy }: {
  account: NormalAccount; folder: ServerFolder; visible: boolean; disabled: boolean; onBusy: (value: boolean) => void;
}) {
  const action = useNormalOrganization(), remoteFlags = useNormalRemoteFlags(), [labels, setLabels] = useState<Label[]>([]), [folders, setFolders] = useState<Folder[]>([]);
  const [taxonomyError, setTaxonomyError] = useState("");
  const state = useNormalInbox(account, visible, "inbox", action.revision, "", remoteFlags.revision, folder.id), result = state.result?.result;
  useEffect(() => {
    let active = true;
    if (visible) { setTaxonomyError(""); Promise.all([loadLabels(), loadFolders()]).then(([nextLabels, nextFolders]) => {
      if (active) { setLabels(nextLabels.items); setFolders(nextFolders.items); }
    }).catch(failure => { if (active) setTaxonomyError(errorMessage(failure)); }); }
    return () => { active = false; };
  }, [visible, action.revision]);
  useEffect(() => { onBusy(state.pending || state.uncertain); return () => onBusy(false); }, [state.pending, state.uncertain, onBusy]);
  const locked = disabled || state.pending || state.uncertain || action.locked;
  const sourceId = folder.wireName.toUpperCase() === "INBOX" ? undefined : folder.id;
  const source = { serverFolderId: sourceId, serverFolderName: folder.name };
  return <section aria-label="服务器文件夹邮件"><h4 dir="auto">{folder.name}</h4>
    <div className="row"><button disabled={disabled || action.locked || state.pending || !account.enabled || !account.credentialConfigured}
      onClick={() => void state.synchronize()}>{state.uncertain ? "重试原文件夹同步" : "同步此文件夹"}</button>
      <button className="secondary" disabled={state.pending} onClick={() => void state.refresh()}>刷新文件夹缓存</button>
      {state.uncertain && <button disabled={state.pending} onClick={() => void state.synchronize(true)}>核对文件夹同步</button>}</div>
    {state.error && <p role="alert">{state.error}</p>}
    {taxonomyError && <p role="alert">{taxonomyError}</p>}
    {state.result?.state === "pending" && <p role="status">同步处理中，请核对原请求</p>}
    {result && <p role="status">本批保存 {result.stored} 封 · 跳过 {result.skipped.length} 封 · {result.complete ? "已检查到本次快照末尾" : "仍有未检查邮件"}</p>}
    <p role="status">{state.reading ? "读取文件夹缓存…" : `已加载 ${state.page?.items.length ?? 0} 封`}</p>
    <NormalInboxMessages key={`${folder.id}:${state.listRevision}`} account={account} items={(state.page?.items ?? []).map(item => ({ ...item, ...source }))}
      pageIds={state.pageIds} labels={labels} folders={folders} serverFolderId={sourceId}
      disabled={locked || state.reading} onOpen={id => void state.open(id)} />
    {state.page?.nextCursor && <button disabled={locked || state.reading} onClick={() => void state.more()}>加载更多文件夹邮件</button>}
    {state.message && <section aria-label="服务器文件夹邮件详情"><NormalMessageContent key={`${folder.id}:${state.message.id}`}
      message={{ ...state.message, ...source }} disabled={locked} /></section>}
  </section>;
}

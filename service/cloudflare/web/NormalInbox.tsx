import { useEffect, useState } from "react";
import { dateText, errorMessage } from "./api";
import type { NormalAccount } from "./normal-accounts";
import { normalInboxPath } from "./normal-inbox";
import { useNormalInbox } from "./useNormalInbox";
import { NormalMessageContent } from "./NormalMessageContent";
import { ExtractionPanel } from "./ExtractionPanel";
import { useNormalOrganization } from "./NormalOrganization";
import { folderOptions, loadFolders, type Folder } from "./folders-api";
import { loadLabels, type Label } from "./labels-api";
import { NormalInboxMessages } from "./NormalInboxMessages";
import { useNormalRemoteFlags } from "./NormalRemoteFlags";
export function NormalInbox({ account, visible, disabled, onBusy }: {
  account: NormalAccount; visible: boolean; disabled: boolean; onBusy: (busy: boolean) => void;
}) {
  const action = useNormalOrganization(), remoteFlags = useNormalRemoteFlags(), [location, setLocation] = useState("inbox"), [folders, setFolders] = useState<Folder[]>([]);
  const [folderError, setFolderError] = useState(""), [labels, setLabels] = useState<Label[]>([]);
  const folderId = location.startsWith("custom:") ? location.slice(7) : "", folder = folderId ? "inbox" : location;
  const state = useNormalInbox(account, visible, folder, action.revision, folderId, remoteFlags.revision), result = state.result?.result, [extracting, setExtracting] = useState(false);
  useEffect(() => {
    let active = true;
    if (visible) { setFolderError(""); Promise.all([loadFolders(), loadLabels()]).then(([nextFolders, nextLabels]) => {
      if (active) { setFolders(nextFolders.items); setLabels(nextLabels.items); } })
      .catch(failure => { if (active) setFolderError(errorMessage(failure)); }); }
    return () => { active = false; };
  }, [visible, action.revision]);
  useEffect(() => { onBusy(state.pending || state.uncertain || extracting); return () => onBusy(false); }, [state.pending, state.uncertain, extracting, onBusy]);
  return <section aria-label="普通邮箱收件"><h3>收件</h3>
    {folderError && <p role="alert">{folderError}</p>}
    <label>普通平台文件夹<select value={location} disabled={action.locked || state.pending || extracting} onChange={event => setLocation(event.target.value)}>
      <option value="inbox">收件箱</option><option value="archive">归档</option><option value="all">全部邮件</option><option value="trash">平台回收站</option>
      {folderOptions(folders).map(({ folder, path }) => <option key={folder.id} value={`custom:${folder.id}`}>{path}</option>)}</select></label>
    <div className="row"><button disabled={disabled || action.locked || state.pending || extracting || !account.enabled || !account.credentialConfigured}
      onClick={() => void state.synchronize()}>{state.uncertain ? "重试原同步" : "同步普通邮箱"}</button>
      <button className="secondary" disabled={state.pending || extracting} onClick={() => void state.refresh()}>刷新缓存邮件</button>
      {state.uncertain && <button disabled={state.pending} onClick={() => void state.synchronize(true)}>核对本次同步</button>}</div>
    {state.error && <p role="alert">{state.error}</p>}
    {state.result?.state === "pending" && <p role="status">同步处理中，请核对原请求</p>}
    {result && <p role="status">本批保存 {result.stored} 封 · 跳过 {result.skipped.length} 封 · {result.complete ? "已检查到本次快照末尾" : "仍有未检查邮件"}</p>}
    {result?.skipped.length ? <ul>{result.skipped.map(row => <li key={row.uid}>UID {row.uid}：{row.reason === "message_too_large" ? "超过单封大小限制" : "读取时邮件已不存在"}</li>)}</ul> : null}
    <p role="status">{state.reading ? "读取缓存…" : `已加载 ${state.page?.items.length ?? 0} 封`}</p>
    <NormalInboxMessages key={`${location}:${state.listRevision}`} account={account} items={state.page?.items ?? []} pageIds={state.pageIds}
      labels={labels} folders={folders} disabled={disabled || state.pending || state.uncertain || extracting || state.reading} onOpen={id => void state.open(id)} />
    {state.page?.nextCursor && <button className="secondary" disabled={state.reading || state.pending || state.uncertain || extracting || action.locked}
      onClick={() => void state.more()}>加载更多普通邮件</button>}
    {state.message && <NormalMessageContent key={state.message.id} message={state.message} disabled={disabled || state.pending || state.uncertain || extracting} />}
    <ExtractionPanel mailboxId={account.id} address={account.emailAddress} visible={visible} usable={true} busy={disabled || state.pending}
      onBusy={setExtracting} onMatch={() => void state.refresh()} cacheOnly sourcePath={`${normalInboxPath(account.id)}/extractions`} />
    {state.history.length > 0 && <section aria-label="普通同步记录"><h4>最近同步</h4><ul>{state.history.map(row => <li key={row.id}>
      {dateText(row.createdAt)} · 版本 {row.accountRevision} · {row.state === "committed" ? `已提交 ${row.result!.stored} 封，跳过 ${row.result!.skipped.length} 封`
        : row.state === "pending" ? "处理中" : "未提交"}</li>)}</ul></section>}
  </section>;
}

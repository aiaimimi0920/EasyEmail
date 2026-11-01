import { useEffect, useRef, useState } from "react";
import type { NormalAccount } from "./normal-accounts";
import { dateText, errorMessage } from "./api";
import { serverFolders, type ServerFolderCatalog, type ServerFolder } from "./normal-server-folders";
import { NormalFolderInbox } from "./NormalFolderInbox";

const roles: Record<string, string> = { inbox: "收件箱", all: "全部邮件", archive: "归档", drafts: "草稿", flagged: "星标", junk: "垃圾邮件", sent: "已发送", trash: "回收站" };
export function NormalServerFolders({ account, visible, disabled, onBusy }: {
  account: NormalAccount; visible: boolean; disabled: boolean; onBusy: (value: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<ServerFolderCatalog | null>(null), [pending, setPending] = useState(false), [reading, setReading] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), active = useRef(false), busy = useRef(false);
  const readGeneration = useRef(0);
  // Keep the selected operation owner alive even when another client removes its catalog entry.
  const [folder, setFolder] = useState<ServerFolder | null>(null), [inboxBusy, setInboxBusy] = useState(false);
  useEffect(() => { onBusy(pending || inboxBusy); return () => onBusy(false); }, [pending, inboxBusy, onBusy]);
  useEffect(() => { active.current = true; return () => { active.current = false; onBusy(false); }; }, [onBusy]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController(), generation = ++readGeneration.current;
    const current = () => !controller.signal.aborted && generation === readGeneration.current;
    setReading(true); setError("");
    serverFolders(account, false, controller.signal).then(row => { if (current()) setCatalog(row); })
      .catch(failure => { if (current()) setError(errorMessage(failure)); })
      .finally(() => { if (current()) setReading(false); });
    return () => controller.abort();
  }, [visible, account.id, account.revision]);
  async function run(discover: boolean) {
    if (busy.current || reading || disabled || inboxBusy) return;
    ++readGeneration.current;
    busy.current = true; setPending(true); setError(""); setNotice("");
    try {
      const row = await serverFolders(account, discover);
      if (active.current) { setCatalog(row); setError(""); setNotice(discover ? `已更新 ${row.items.length} 个服务器文件夹` : "已读取缓存目录"); }
    } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally {
      ++readGeneration.current;
      busy.current = false;
      if (active.current) { setPending(false); setReading(false); }
    }
  }
  return <section aria-label="服务器文件夹"><h3>服务器文件夹</h3>
    <div className="row"><button disabled={disabled || pending || reading || inboxBusy || !account.enabled || !account.credentialConfigured}
      onClick={() => void run(true)}>发现服务器文件夹</button>
      <button className="secondary" disabled={disabled || pending || reading || inboxBusy} onClick={() => void run(false)}>刷新缓存目录</button></div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {(pending || reading) && <p role="status">{pending ? "读取目录中…" : "读取缓存目录…"}</p>}
    {catalog && !catalog.current && <p>暂无当前来源目录</p>}
    {catalog?.current && <><p>目录观察时间：{dateText(catalog.observedAt)} · {catalog.items.length} 个</p>
      <ul>{catalog.items.map(folder => <li key={folder.id}><div><strong dir="auto">{folder.name}</strong>
        <small>{folder.selectable ? "可选" : "不可选"}{folder.roles.length ? ` · ${folder.roles.map(role => roles[role]).join("、")}` : ""}</small>
        {folder.selectable && <button className="secondary" disabled={disabled || pending || inboxBusy} onClick={() => setFolder(folder)}>查看 {folder.name} 邮件</button>}</div></li>)}</ul>
      {catalog.items.length === 0 && <p>服务器返回空目录</p>}</>}
    {folder && <><button className="secondary" disabled={pending || inboxBusy} onClick={() => setFolder(null)}>关闭文件夹邮件</button>
      <NormalFolderInbox key={`${account.id}:${account.revision}:${folder.id}`} account={account} folder={folder} visible={visible}
        disabled={disabled || pending} onBusy={setInboxBusy} /></>}
  </section>;
}

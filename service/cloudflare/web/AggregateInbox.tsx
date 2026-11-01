import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorMessage, type Compose } from "./api";
import { loadLabels, type Label } from "./labels-api";
import { LabelManager } from "./LabelManager";
import { useOrganization } from "./useOrganization";
import { folderOptions, loadFolders, type Folder } from "./folders-api";
import { FolderManager } from "./FolderManager";
import { ConversationResults } from "./ConversationResults";
import { UnifiedInboxResults } from "./UnifiedInboxResults";
import { useNormalOrganization } from "./NormalOrganization";

export function AggregateInbox({ onCompose, visible }: { onCompose: Compose; visible: boolean }) {
  const [query, setQuery] = useState("sources=all&folder=inbox"), [sources, setSources] = useState("all"), [folder, setFolder] = useState("inbox");
  const [mode, setMode] = useState("messages");
  const [providers, setProviders] = useState<{ id: string }[]>([]);
  const [labels, setLabels] = useState<Label[]>([]), [labelRevision, setLabelRevision] = useState(0), [revision, setRevision] = useState(0);
  const [folders, setFolders] = useState<Folder[]>([]);
  const refresh = () => setRevision(value => value + 1);
  const action = useOrganization(refresh);
  const normal = useNormalOrganization(), locked = action.locked || normal.locked;
  const [opened, setOpened] = useState(visible);
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current && opened && !locked) { refresh(); setLabelRevision(value => value + 1); }
    wasVisible.current = visible;
    if (visible) setOpened(true);
  }, [visible, opened, locked]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!opened) return;
    let active = true;
    api<{ items: { id: string }[] }>("/providers").then((value) => { if (active) setProviders(value.items); })
      .catch((failure) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [opened]);
  useEffect(() => {
    if (!opened) return;
    let active = true;
    loadLabels().then(value => { if (active) setLabels(value.items); }).catch(failure => { if (active) setError(errorMessage(failure)); });
    loadFolders().then(value => {
      if (!active) return;
      setFolders(value.items);
      setQuery(old => {
        const params = new URLSearchParams(old), selected = params.get("folderId");
        if (!selected || value.items.some(folder => folder.id === selected)) return old;
        params.delete("folderId"); return params.toString();
      });
    }).catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [labelRevision, opened]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    const values = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    for (const [key, raw] of values.entries()) {
      const value = String(raw).trim();
      if (value) params.set(key, key === "since" || key === "until" ? String(Math.floor(new Date(value).getTime() / 1000)) : value);
    }
    setQuery(params.toString());
  }

  if (!opened) return null;
  return <section className="card" aria-label="聚合邮件"><h2>聚合收件箱</h2>
    <LabelManager labels={labels} disabled={locked} onChanged={() => { setLabelRevision(value => value + 1); refresh(); }} />
    <FolderManager folders={folders} disabled={locked} onChanged={() => { setLabelRevision(value => value + 1); refresh(); }} />
    <form onSubmit={search}>
      <fieldset disabled={locked}>
      <div className="row"><label>搜索缓存邮件<input name="q" maxLength={256} type="search" /></label>
        <label>邮件来源<select name="sources" value={sources} onChange={event => setSources(event.target.value)}>
          <option value="all">全部来源</option><option value="temporary">临时邮箱</option><option value="normal">普通邮箱</option></select></label>
        <label>文件夹<select name="folder" value={folder} onChange={event => setFolder(event.target.value)}><option value="inbox">收件箱</option><option value="archive">归档</option><option value="all">全部邮件</option><option value="trash">平台回收站</option></select></label>
        <label>供应商筛选<select name="providerId" disabled={sources === "normal"}><option value="">全部供应商</option>{providers.map((provider) => <option key={provider.id}>{provider.id}</option>)}</select></label></div>
      <div className="row"><label>发件人筛选<input name="sender" maxLength={320} /></label><label>收件地址筛选<input name="recipient" maxLength={320} /></label>
        <label>阅读状态<select name="isRead"><option value="">全部</option><option value="false">未读</option><option value="true">已读</option></select></label>
        <label>星标筛选<select name="starred"><option value="">全部</option><option value="true">有星标</option><option value="false">无星标</option></select></label></div>
      <div className="row"><label>收件时间从<input name="since" type="datetime-local" /></label>
        <label>收件时间至<input name="until" type="datetime-local" /></label>
        <label>标签筛选<select name="labelId"><option value="">全部标签</option>{labels.map(label => <option key={label.id} value={label.id}>{label.name}</option>)}</select></label>
        <label>自定义文件夹筛选<select name="folderId"><option value="">不指定文件夹</option>{folderOptions(folders).map(({ folder, path }) => <option key={folder.id} value={folder.id}>{path}</option>)}</select></label>
        <button>搜索邮件</button></div>
      </fieldset>
    </form>
    {error && <p role="alert">{error}</p>}
    <div className="row"><button type="button" className="secondary" disabled={locked} aria-pressed={mode === "messages"} onClick={() => setMode("messages")}>逐封视图</button>
      <button type="button" className="secondary" disabled={locked} aria-pressed={mode === "conversations"} onClick={() => setMode("conversations")}>会话视图</button></div>
    {mode === "messages" ? <UnifiedInboxResults key={query} query={query} onCompose={onCompose} labels={labels} folders={folders} action={action} revision={revision + normal.revision} refresh={refresh} />
      : <ConversationResults key={query} query={query} onCompose={onCompose} revision={revision + normal.revision} refresh={refresh} />}
  </section>;
}

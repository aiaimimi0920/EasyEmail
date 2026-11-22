import { Button, Field, Input, Notice, Panel, Select } from '@neuro/ui';
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
  return <Panel className="card" aria-label="聚合邮件"><h2>聚合收件箱</h2>
    <LabelManager labels={labels} disabled={locked} onChanged={() => { setLabelRevision(value => value + 1); refresh(); }} />
    <FolderManager folders={folders} disabled={locked} onChanged={() => { setLabelRevision(value => value + 1); refresh(); }} />
    <form onSubmit={search}>
      <fieldset disabled={locked}>
      <div className="row"><Field label="搜索缓存邮件"><Input name="q" maxLength={256} type="search" /></Field>
        <Field label="邮件来源"><Select name="sources" value={sources} onChange={event => setSources(event.target.value)}>
          <option value="all">全部来源</option><option value="temporary">临时邮箱</option><option value="normal">普通邮箱</option></Select></Field>
        <Field label="文件夹"><Select name="folder" value={folder} onChange={event => setFolder(event.target.value)}><option value="inbox">收件箱</option><option value="archive">归档</option><option value="all">全部邮件</option><option value="trash">平台回收站</option></Select></Field>
        <Field label="供应商筛选"><Select name="providerId" disabled={sources === "normal"}><option value="">全部供应商</option>{providers.map((provider) => <option key={provider.id}>{provider.id}</option>)}</Select></Field></div>
      <div className="row"><Field label="发件人筛选"><Input name="sender" maxLength={320} /></Field><Field label="收件地址筛选"><Input name="recipient" maxLength={320} /></Field>
        <Field label="阅读状态"><Select name="isRead"><option value="">全部</option><option value="false">未读</option><option value="true">已读</option></Select></Field>
        <Field label="星标筛选"><Select name="starred"><option value="">全部</option><option value="true">有星标</option><option value="false">无星标</option></Select></Field></div>
      <div className="row"><Field label="收件时间从"><Input name="since" type="datetime-local" /></Field>
        <Field label="收件时间至"><Input name="until" type="datetime-local" /></Field>
        <Field label="标签筛选"><Select name="labelId"><option value="">全部标签</option>{labels.map(label => <option key={label.id} value={label.id}>{label.name}</option>)}</Select></Field>
        <Field label="自定义文件夹筛选"><Select name="folderId"><option value="">不指定文件夹</option>{folderOptions(folders).map(({ folder, path }) => <option key={folder.id} value={folder.id}>{path}</option>)}</Select></Field>
        <Button type="submit" wrap>搜索邮件</Button></div>
      </fieldset>
    </form>
    {error && <Notice role="alert" tone="danger">{error}</Notice>}
    <div className="row"><Button type="button" disabled={locked} aria-pressed={mode === "messages"} onClick={() => setMode("messages")} variant="quiet" wrap>逐封视图</Button>
      <Button type="button" disabled={locked} aria-pressed={mode === "conversations"} onClick={() => setMode("conversations")} variant="quiet" wrap>会话视图</Button></div>
    {mode === "messages" ? <UnifiedInboxResults key={query} query={query} onCompose={onCompose} labels={labels} folders={folders} action={action} revision={revision + normal.revision} refresh={refresh} />
      : <ConversationResults key={query} query={query} onCompose={onCompose} revision={revision + normal.revision} refresh={refresh} />}
  </Panel>;
}

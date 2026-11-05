import { Button, Notice, Panel } from '@neuro/ui';
import { useEffect, useRef, useState } from "react";
import { api, dateText, errorMessage, type Page } from "./api";
import type { DraftSummary } from "./cloud-drafts";

export function CloudDrafts({ visible, revision, disabled, onOpen, onDelete, basePath = "/drafts", title = "云端草稿" }: {
  visible: boolean; revision: number; disabled: boolean; onOpen: (id: string) => void; onDelete: (id: string, revision: number) => void;
  basePath?: string; title?: string;
}) {
  const [page, setPage] = useState<Page<DraftSummary>>({ items: [], nextCursor: null });
  const [error, setError] = useState(""), [pending, setPending] = useState(false);
  const generation = useRef(0);
  async function load(cursor = "") {
    const current = ++generation.current;
    setPending(true); setError("");
    try {
      const next = await api<Page<DraftSummary>>(`${basePath}?limit=25${cursor ? `&cursor=${cursor}` : ""}`);
      if (current === generation.current) setPage(old => cursor ? { ...next, items: [...old.items, ...next.items] } : next);
    } catch (failure) { if (current === generation.current) setError(errorMessage(failure)); }
    finally { if (current === generation.current) setPending(false); }
  }
  useEffect(() => {
    if (visible) void load();
    return () => { generation.current++; };
  }, [visible, revision, basePath]);
  return <Panel className="card" aria-label={title}><h2>{title}</h2>
    <Button disabled={pending || disabled} onClick={() => void load()} variant="quiet" wrap>刷新草稿</Button>
    {error && <Notice role="alert" tone="danger">{error}</Notice>}
    <ul>{page.items.map(draft => <li key={draft.id}><div>
      <Button disabled={disabled} onClick={() => onOpen(draft.id)} variant="quiet" wrap>{draft.subject || "（无主题）"}</Button>
      <small>{draft.state === "submitted" ? "已提交发送" : "草稿"} · 版本 {draft.revision} · {dateText(draft.updatedAt)}</small>
    </div><Button disabled={disabled} onClick={() => onDelete(draft.id, draft.revision)} variant="quiet" wrap>删除草稿</Button></li>)}</ul>
    {!page.items.length && !pending && <p>暂无云端草稿</p>}
    {page.nextCursor && <Button disabled={disabled || pending} onClick={() => void load(page.nextCursor!)} wrap>更多草稿</Button>}
  </Panel>;
}

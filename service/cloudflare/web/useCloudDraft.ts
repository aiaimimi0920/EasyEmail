import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { composeDraft, draftFields, draftKey, emptyDraft, type CloudDraft, type ComposeDraft } from "./cloud-drafts";

export function useCloudDraft(value: ComposeDraft, replace: (draft: ComposeDraft) => void, locked: boolean,
  options: { basePath?: string; createEmpty?: () => ComposeDraft } = {}) {
  const base = options.basePath ?? "/drafts", createEmpty = options.createEmpty ?? emptyDraft;
  const [saved, setSaved] = useState<CloudDraft | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const id = useRef<string>(crypto.randomUUID()), busy = useRef(false), active = useRef(false);
  const dirty = draftKey(value) !== draftKey(saved ? composeDraft(saved) : createEmpty());
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const canReplace = () => !dirty || window.confirm("当前内容尚未保存到云端，是否放弃这些修改？");

  function reset() { id.current = crypto.randomUUID(); setSaved(null); setError(""); }
  async function action(run: () => Promise<void>) {
    if (busy.current || locked) return;
    busy.current = true; setPending(true); setError("");
    try { await run(); }
    catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  async function open(draftId: string) {
    if (busy.current || locked || !canReplace()) return;
    await action(async () => {
      const result = await api<{ draft: CloudDraft }>(`${base}/${draftId}`);
      if (active.current) { id.current = result.draft.id; setSaved(result.draft); replace(composeDraft(result.draft)); }
    });
  }
  async function save() {
    await action(async () => {
      const result = await api<{ draft: CloudDraft }>(`${base}/${id.current}`, "PUT", {
        ...draftFields(value), expectedRevision: saved?.revision ?? 0,
      });
      if (active.current) { setSaved(result.draft); replace(composeDraft(result.draft)); setRevision(old => old + 1); }
    });
  }
  async function remove(draftId: string, expectedRevision: number) {
    if (busy.current || locked || !window.confirm("删除这份云端草稿？若它正在编辑，当前编辑内容也将清除；已提交发送不会撤销。")) return;
    await action(async () => {
      await api(`${base}/${draftId}`, "DELETE", { expectedRevision });
      if (active.current) {
        if (id.current === draftId) { reset(); replace(createEmpty()); }
        setRevision(old => old + 1);
      }
    });
  }
  function submitted(outgoingId: string | null) {
    setSaved(old => old && old.state === "editing" ? { ...old, state: "submitted", revision: old.revision + 1, outgoingId } : old);
    setRevision(old => old + 1);
  }
  return { saved, pending, busy, error, revision, dirty, canReplace, reset, open, save, remove, submitted,
    check: () => open(id.current) };
}

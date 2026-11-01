import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, ApiError, errorMessage, type ComposeRequest, type Mailbox, type Page } from "./api";
import { OutgoingHistory } from "./OutgoingHistory";
import { sendState, type Outgoing } from "./outgoing";
import { mailboxExpired, useMailboxExpiry } from "./mailbox-expiry";
import { draftFields, emptyDraft, type ComposeDraft } from "./cloud-drafts";
import { useCloudDraft } from "./useCloudDraft";
import { CloudDrafts } from "./CloudDrafts";
import { ContactPicker } from "./ContactPicker";
import { ComposeRecipients } from "./ComposeRecipients";
import { hasMultipleRecipients } from "./compose-recipients";
import { OutboxAttachments } from "./OutboxAttachments";
import { SendSchedule, scheduledValue, type SendMode } from "./SendSchedule";
import { SendJobs } from "./SendJobs";
import { jobState, type SendJob } from "./send-jobs";

interface Provider { id: string; capabilities: { send: boolean; replyHeaders: boolean; multipleRecipients: boolean; attachmentSend: boolean } }
interface Attempt { key: string; draft: ComposeDraft; uncertain: boolean; scheduledAt?: number | null; cloud?: { draftId: string; draftRevision: number } }

export function Composer({ visible, request }: { visible: boolean; request: ComposeRequest | null }) {
  const [boxes, setBoxes] = useState<Mailbox[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [draft, setDraft] = useState<ComposeDraft>(emptyDraft);
  const [confirmed, setConfirmed] = useState(false);
  const [newConfirmed, setNewConfirmed] = useState(false);
  const [result, setResult] = useState<Outgoing | null>(null);
  const [job, setJob] = useState<SendJob | null>(null);
  const [mode, setMode] = useState<SendMode>("direct"), [scheduleTime, setScheduleTime] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [uploadLocked, setUploadLocked] = useState(false), [assetsReady, setAssetsReady] = useState(true);
  const uploadBusy = useRef(false);
  const attempt = useRef<Attempt | null>(null);
  const busy = useRef(false);
  const active = useRef(false);
  const consumedRequest = useRef("");
  const ids = useId();
  const cloud = useCloudDraft(draft, (next) => { setDraft(next); setAssetsReady(!next.attachments?.length); setConfirmed(false); setResult(null); setError(""); }, !!attempt.current || uploadLocked);
  useMailboxExpiry(boxes);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!visible) return;
    let current = true;
    Promise.all([api<Page<Mailbox>>("/mailboxes?limit=100"), api<{ items: Provider[] }>("/providers")])
      .then(([mail, catalog]) => {
        if (!current) return;
        setBoxes(mail.items); setProviders(catalog.items); setRevision((value) => value + 1);
      }).catch((failure) => { if (current) setError(errorMessage(failure)); });
    return () => { current = false; };
  }, [visible, request?.nonce]);

  useEffect(() => {
    if (!request || request.nonce === consumedRequest.current) return;
    consumedRequest.current = request.nonce;
    if (attempt.current || cloud.busy.current || uploadBusy.current) { setError("请先处理当前发送、上传或草稿保存，或显式新建另一封邮件。"); return; }
    if (!cloud.canReplace()) return;
    cloud.reset();
    setDraft({ mailboxId: request.mailboxId, to: request.message?.replyAddress ?? "", text: "",
      subject: request.message ? (/^re:/i.test(request.message.subject) ? request.message.subject : `Re: ${request.message.subject}`).slice(0, 200) : "",
      ...(request.message ? { replyToMessageId: request.message.id } : {}) });
    setConfirmed(false); setError(""); setMode("direct"); setScheduleTime(""); setJob(null);
  }, [request]);

  const selected = boxes.find((box) => box.id === draft.mailboxId);
  const capability = providers.find((provider) => provider.id === selected?.providerId)?.capabilities;
  const usable = selected?.status === "active" && !mailboxExpired(selected) && !selected.disabled && selected.releasedAt === null;
  const locked = !!attempt.current || cloud.saved?.state === "submitted";
  const recipientsSupported = !hasMultipleRecipients(draft) || !!capability?.multipleRecipients;
  const filesSupported = !draft.attachments?.length || !!capability?.attachmentSend;

  function update(fields: Partial<ComposeDraft>) { setDraft((old) => ({ ...old, ...fields })); setConfirmed(false); }
  function newDraft() {
    if (busy.current || cloud.busy.current || uploadBusy.current || (uncertain && !newConfirmed) || (!attempt.current && !cloud.canReplace())) return;
    cloud.reset();
    attempt.current = null; setDraft(emptyDraft()); setAssetsReady(true); setResult(null); setUncertain(false);
    setJob(null); setMode("direct"); setScheduleTime("");
    setConfirmed(false); setNewConfirmed(false); setError("");
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy.current || cloud.busy.current || uploadBusy.current || (!attempt.current && (cloud.saved?.state === "submitted" || !confirmed || !capability?.send || !usable || !recipientsSupported || !filesSupported || !assetsReady))) return;
    if (!attempt.current && cloud.saved && cloud.dirty) { setError("请先保存草稿更改后再发送。"); return; }
    let scheduledAt: number | null | undefined;
    if (!attempt.current) {
      try { scheduledAt = scheduledValue(mode, scheduleTime); }
      catch (failure) { setError(failure instanceof Error ? failure.message : "计划时间无效"); return; }
    }
    busy.current = true; setPending(true); setError("");
    attempt.current ??= { key: crypto.randomUUID(), draft: { ...draft }, uncertain: false, scheduledAt,
      ...(cloud.saved ? { cloud: { draftId: cloud.saved.id, draftRevision: cloud.saved.revision } } : {}) };
    const current = attempt.current;
    const { mailboxId, ...body } = draftFields(current.draft);
    try {
      if (current.scheduledAt !== undefined) {
        const value = await api<{ job: SendJob }>(`/mailboxes/${mailboxId}/send-jobs`, "POST", { ...body, ...current.cloud, scheduledAt: current.scheduledAt }, { "idempotency-key": current.key });
        if (active.current) {
          current.uncertain = false; setJob(value.job); setUncertain(false); setRevision(old => old + 1);
          if (current.cloud) cloud.submitted(null);
        }
      } else {
        const value = await api<{ outgoing: Outgoing }>(`/mailboxes/${mailboxId}/outgoing`, "POST", { ...body, ...current.cloud }, { "idempotency-key": current.key });
        if (active.current) {
          current.uncertain = value.outgoing.state === "pending" || value.outgoing.state === "unknown";
          setResult(value.outgoing); setUncertain(current.uncertain); setRevision((value) => value + 1);
          if (current.cloud) cloud.submitted(value.outgoing.id);
        }
      }
    } catch (failure) {
      if (active.current) {
        setError(errorMessage(failure));
        if (!current.uncertain && failure instanceof ApiError && failure.status < 500) attempt.current = null;
        else { current.uncertain = true; setUncertain(true); }
      }
    } finally { busy.current = false; if (active.current) setPending(false); }
  }

  const editingLocked = locked || pending || cloud.pending || uploadLocked;
  return <>
    <section className="card" aria-label="写信"><h2>{draft.replyToMessageId ? "回复邮件" : "写信"}</h2>
      <ContactPicker visible={visible} disabled={editingLocked} onPick={(address, target, append) => {
        if (busy.current || cloud.busy.current || uploadBusy.current || attempt.current || cloud.saved?.state === "submitted") return;
        update({ [target]: append && draft[target] ? `${draft[target]}, ${address}` : address });
      }} />
      <form onSubmit={send}>
        <label htmlFor={`${ids}-from`}>发件邮箱</label><select id={`${ids}-from`} value={draft.mailboxId} disabled={editingLocked}
          onChange={(event) => update({ mailboxId: event.target.value, replyToMessageId: undefined })} required>
          <option value="">选择发件邮箱</option>{boxes.filter((box) => box.status === "active" && !mailboxExpired(box) && !box.disabled && box.releasedAt === null).map((box) => <option key={box.id} value={box.id}>{box.address}</option>)}
        </select>
        {selected && !capability?.send && <p role="status">此邮箱尚未启用发送</p>}
        {selected && mailboxExpired(selected) && <p role="status">平台访问已到期；仍可核对原发送结果</p>}
        {draft.replyToMessageId && <p>{capability?.replyHeaders ? "可用的原邮件线程头将随回复提交；未验证实际会话归并。" : "此通道不支持线程头，回复将作为普通邮件发送。"} 收件地址来自原发件人，请核对。</p>}
        <ComposeRecipients ids={ids} value={draft} disabled={editingLocked} onChange={update} />
        {selected && !recipientsSupported && <p role="status">此发送通道仅支持单个收件地址，不支持抄送或密送；草稿仍可保存。</p>}
        <label htmlFor={`${ids}-subject`}>邮件主题</label><input id={`${ids}-subject`} value={draft.subject} maxLength={200} required disabled={editingLocked} onChange={(event) => update({ subject: event.target.value })} />
        <label htmlFor={`${ids}-text`}>纯文本正文</label><textarea id={`${ids}-text`} value={draft.text} maxLength={6000} required disabled={editingLocked} onChange={(event) => update({ text: event.target.value })} />
        <OutboxAttachments value={draft.attachments ?? []} disabled={locked || pending || cloud.pending} supported={!!capability?.attachmentSend}
          onChange={attachments => { setAssetsReady(!attachments.length); update({ attachments }); }} onReady={setAssetsReady}
          onLock={value => { uploadBusy.current = value; setUploadLocked(value); setConfirmed(false); }} />
        <SendSchedule mode={mode} time={scheduleTime} disabled={editingLocked} onChange={(next, time) => {
          setMode(next); setScheduleTime(time); setConfirmed(false);
        }} />
        <label className="check"><input type="checkbox" checked={confirmed} disabled={editingLocked} onChange={(event) => setConfirmed(event.target.checked)} />我已核对收件地址和内容，确认提交一次发送</label>
        <button disabled={pending || cloud.pending || uploadLocked || (!locked && (!confirmed || !capability?.send || !usable || !recipientsSupported || !filesSupported || !assetsReady)) || (locked && (!uncertain || !attempt.current))}>{uncertain ? "检查本次发送结果" : mode === "direct" ? "确认发送" : mode === "scheduled" ? "确认定时发送" : "确认加入队列"}</button>
      </form>
      <div className="row"><button className="secondary" disabled={editingLocked} onClick={() => void cloud.save()}>保存云端草稿</button>
        {(cloud.saved || cloud.error) && <button className="secondary" disabled={pending || cloud.pending || uploadLocked || !!attempt.current} onClick={() => void cloud.check()}>核对云端版本</button>}</div>
      {cloud.saved && <p role="status">{cloud.saved.state === "submitted" ? "此草稿已提交发送，请查看发送记录" : cloud.dirty ? "有未保存的修改" : `已保存到云端 · 版本 ${cloud.saved.revision}`}</p>}
      {cloud.error && <p role="alert">{cloud.error}</p>}
      {error && <p role="alert">{error}</p>}
      {result && <p role="status">{sendState(result.state)}</p>}
      {job && <p role="status">{jobState(job.state)}</p>}
      {uncertain && !result && <p role="status">发送结果待确认，请勿重复发送</p>}
      {attempt.current && <p>本次幂等键：<code data-testid="send-attempt-key">{attempt.current.key}</code></p>}
      {uncertain && <label className="check"><input type="checkbox" checked={newConfirmed} onChange={(event) => setNewConfirmed(event.target.checked)} />我已核对发送记录，另起一封邮件，不会重试本次发送</label>}
      <button className="secondary" disabled={pending || cloud.pending || uploadLocked || (uncertain && !newConfirmed)} onClick={newDraft}>新建另一封邮件</button>
    </section>
    <CloudDrafts visible={visible} revision={cloud.revision} disabled={pending || cloud.pending || uploadLocked || !!attempt.current}
      onOpen={(id) => void cloud.open(id)} onDelete={(id, revision) => void cloud.remove(id, revision)} />
    {visible && <OutgoingHistory revision={revision} />}
    <SendJobs revision={revision} visible={visible} />
  </>;
}

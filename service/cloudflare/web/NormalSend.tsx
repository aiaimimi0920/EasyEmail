import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { api, dateText, errorMessage, type Page } from "./api";
import type { NormalAccount } from "./normal-accounts";
import { ComposeRecipients } from "./ComposeRecipients";
import { recipientFields } from "./compose-recipients";
import { emptyDraft, type ComposeDraft } from "./cloud-drafts";
import { useCloudDraft } from "./useCloudDraft";
import { CloudDrafts } from "./CloudDrafts";
import { useNormalReply, type NormalReplyIntent, type ReplyGuard } from "./NormalReply";
import { OutboxAttachments } from "./OutboxAttachments";
import { outboxRefs } from "./outbox-attachments";
import { SendSchedule, scheduledValue, type SendMode } from "./SendSchedule";
import { SendJobs } from "./SendJobs";
import { jobState, type SendJob } from "./send-jobs";

interface Outgoing {
  id: string; accountId: string; requestKey: string; from: string; subject: string; state: string; error: string | null; createdAt: number;
}
interface Attempt { accountId: string; from: string; key: string; body: Record<string, unknown>; maySubmit: boolean; kind: "direct" | "job" }
export function NormalSend({ account, smtp, disabled, onBusy, reply, replyGuard, onReplyConsumed }: {
  account: NormalAccount; smtp: { revision: number; enabled: boolean; current: boolean; credentialConfigured: boolean };
  disabled: boolean; onBusy: (busy: boolean) => void;
  reply: NormalReplyIntent | null; replyGuard: ReplyGuard; onReplyConsumed: () => void;
}) {
  const createEmpty = (): ComposeDraft => ({ ...emptyDraft(), normalAccountId: account.id, accountRevision: account.revision });
  const [draft, setDraft] = useState<ComposeDraft>(createEmpty);
  const [attempt, setAttempt] = useState<Attempt | null>(null), [receipt, setReceipt] = useState<Outgoing | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [history, setHistory] = useState<Page<Outgoing> | null>(null);
  const [mode, setMode] = useState<SendMode>("direct"), [time, setTime] = useState("");
  const [job, setJob] = useState<SendJob | null>(null), [queueRevision, setQueueRevision] = useState(0), [queueLocked, setQueueLocked] = useState(false);
  const queueBusy = useRef(false), openingDraft = useRef(false);
  const reportQueue = useCallback((value: boolean) => { queueBusy.current = value; setQueueLocked(value); }, []);
  const resetSchedule = () => { setMode("direct"); setTime(""); };
  const [uploadLocked, setUploadLocked] = useState(false), [assetsReady, setAssetsReady] = useState(true);
  const uploadBusy = useRef(false);
  const busy = useRef(false);
  const basePath = `/normal-accounts/${account.id}/drafts`;
  const cloud = useCloudDraft(draft, next => {
    if (JSON.stringify(outboxRefs(next.attachments)) !== JSON.stringify(outboxRefs(draft.attachments))) setAssetsReady(!next.attachments?.length);
    if (openingDraft.current) resetSchedule();
    setDraft(next);
  }, pending || !!attempt || uploadLocked || queueLocked, { basePath, createEmpty });
  const baseLocked = pending || !!attempt || cloud.pending || cloud.saved?.state === "submitted" || queueLocked;
  const locked = baseLocked || uploadLocked;
  const staleSource = draft.accountRevision !== account.revision;
  const navigationLocked = pending || !!attempt || cloud.pending || cloud.dirty || uploadLocked || queueLocked;
  const intents = useNormalReply(), consumed = useRef("");
  useLayoutEffect(() => {
    const check = () => !disabled && !busy.current && !cloud.busy.current && !uploadBusy.current && !queueBusy.current && !pending && !attempt && !cloud.dirty;
    replyGuard.current = check;
    return () => { if (replyGuard.current === check) replyGuard.current = null; };
  });
  useLayoutEffect(() => {
    if (!reply || consumed.current === reply.nonce) return;
    consumed.current = reply.nonce; onReplyConsumed();
    if (busy.current || cloud.busy.current || uploadBusy.current || queueBusy.current || pending || attempt || cloud.dirty
      || reply.account.id !== account.id || reply.reply.accountRevision !== account.revision) { intents.reject(); return; }
    cloud.reset(); resetSchedule(); setJob(null); setAssetsReady(true); setDraft({ ...createEmpty(), to: reply.reply.to, subject: reply.reply.subject, replyToMessageId: reply.reply.messageId });
    setReceipt(null); setError(""); setNotice(reply.reply.threading === "unavailable" ? "原信缺少有效 Message-ID，本次回复不附线程头" : "");
  }, [reply]);
  useEffect(() => { onBusy(navigationLocked); }, [navigationLocked, onBusy]);
  const update = (fields: Partial<ComposeDraft>) => setDraft(old => ({ ...old, ...fields }));
  function startNew() {
    if (busy.current || cloud.busy.current || uploadBusy.current || queueBusy.current || (attempt ? !window.confirm("原邮件可能已发送或排队。另起邮件不会撤销原操作，重复提交可能产生重复邮件。确认另起？") : !cloud.canReplace())) return;
    cloud.reset(); resetSchedule(); setJob(null); setAssetsReady(true); setDraft(createEmpty()); setAttempt(null); setReceipt(null); setNotice(""); setError("");
  }
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy.current || cloud.busy.current || uploadBusy.current || queueBusy.current || (!attempt && (disabled || !account.enabled || !smtp.enabled || !smtp.current || !smtp.credentialConfigured || cloud.saved?.state === "submitted" || staleSource || !assetsReady))) return;
    if (!attempt && cloud.saved && cloud.dirty) { setError("请先保存草稿更改后再发送。"); return; }
    let scheduledAt: number | null | undefined;
    if (!attempt) { try { scheduledAt = scheduledValue(mode, time); } catch (failure) { setError((failure as Error).message); return; } }
    busy.current = true;
    const current = attempt ?? { accountId: account.id, from: account.emailAddress, key: crypto.randomUUID(), maySubmit: true,
      kind: mode === "direct" ? "direct" as const : "job" as const,
      body: { expectedRevision: account.revision, smtpRevision: smtp.revision, ...recipientFields(draft), subject: draft.subject, text: draft.text,
        ...(scheduledAt === undefined ? {} : { scheduledAt }),
        ...(draft.replyToMessageId ? { replyToMessageId: draft.replyToMessageId } : {}),
        ...(draft.attachments?.length ? { attachments: outboxRefs(draft.attachments) } : {}),
        ...(cloud.saved ? { draftId: cloud.saved.id, draftRevision: cloud.saved.revision } : {}) } };
    setAttempt({ ...current, maySubmit: false }); setPending(true); setError(""); setNotice("");
    try {
      const result = await api<{ outgoing: Outgoing; job: SendJob }>(`/normal-accounts/${current.accountId}/${current.kind === "direct" ? "send" : "send-jobs"}`, "POST", current.body, { "idempotency-key": current.key });
      if (current.kind === "job") { setJob(result.job); setQueueRevision(old => old + 1); if (current.body.draftId) cloud.submitted(null); }
      else { setReceipt(result.outgoing); if (current.body.draftId) cloud.submitted(result.outgoing.id); }
    }
    catch (failure) { setError(errorMessage(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  async function check() {
    if (!attempt || busy.current) return; busy.current = true; setPending(true); setError(""); setNotice("");
    try {
      const result = await api<{ outgoing: Outgoing; job: SendJob }>(`/normal-accounts/${attempt.accountId}/${attempt.kind === "direct" ? "outgoing" : "send-jobs"}?requestKey=${encodeURIComponent(attempt.key)}`);
      if (attempt.kind === "job") { setJob(result.job); setQueueRevision(old => old + 1); if (attempt.body.draftId) cloud.submitted(null); }
      else { setReceipt(result.outgoing); if (attempt.body.draftId) cloud.submitted(result.outgoing.id); }
    }
    catch (failure) {
      if (failure instanceof Error && failure.message === "not_found") {
        setAttempt({ ...attempt, maySubmit: true }); setNotice(attempt.kind === "job" ? "暂未找到入队记录，可显式提交原入队；原安排和操作键保持不变" : "暂未找到发送预约，可显式提交原发送；原操作键保持不变");
      } else setError(errorMessage(failure));
    } finally { busy.current = false; setPending(false); }
  }
  async function loadHistory(more = false) {
    if (busy.current || queueBusy.current) return; busy.current = true; setPending(true); setError("");
    try {
      const page = await api<Page<Outgoing>>(`/normal-accounts/${account.id}/outgoing${more && history?.nextCursor ? `?cursor=${history.nextCursor}` : ""}`);
      setHistory({ ...page, items: more ? [...(history?.items ?? []), ...page.items] : page.items });
    } catch (failure) { setError(errorMessage(failure)); } finally { busy.current = false; setPending(false); }
  }
  const stateText = (state: string) => ({ accepted: "服务器已接受，投递未确认", rejected: "服务器未接受", pending: "处理中，禁止重复提交", unknown: "结果未知，禁止自动重发" }[state] ?? state);
  return <section aria-label="普通邮箱发信"><h3>普通邮箱发信</h3>
    <p>{attempt?.from ?? account.emailAddress}</p>
    {draft.replyToMessageId && <div><p>回复原邮件 {draft.replyToMessageId}</p>
      <button className="secondary" disabled={disabled || locked} onClick={() => update({ replyToMessageId: undefined })}>改为新邮件</button></div>}
    {staleSource && <div role="status">草稿关联账号版本 {draft.accountRevision}，当前版本 {account.revision}
      <button disabled={disabled || locked} onClick={() => {
        if (window.confirm(`账号身份或配置可能已变化。确认以当前发件地址 ${account.emailAddress} 继续编辑并重新保存此草稿？`)) update({ accountRevision: account.revision });
      }}>关联到当前账号版本</button>
    </div>}
    <form onSubmit={event => void submit(event)}>
      <ComposeRecipients ids="normal-send" value={draft} disabled={disabled || locked} onChange={update} />
      <label htmlFor="normal-send-subject">普通邮件主题</label><input id="normal-send-subject" value={draft.subject} maxLength={200} required disabled={disabled || locked} onChange={event => update({ subject: event.target.value })} />
      <label htmlFor="normal-send-text">普通邮件正文</label><textarea id="normal-send-text" value={draft.text} maxLength={6000} required disabled={disabled || locked} onChange={event => update({ text: event.target.value })} />
      <OutboxAttachments value={draft.attachments ?? []} disabled={disabled || baseLocked} supported
        onChange={attachments => { setAssetsReady(!attachments.length); update({ attachments }); }} onReady={setAssetsReady}
        onLock={value => { uploadBusy.current = value; setUploadLocked(value); }} />
      <SendSchedule mode={mode} time={time} disabled={disabled || locked} onChange={(next, value) => { setMode(next); setTime(value); }} />
      <button disabled={disabled || locked || !assetsReady || staleSource || !!cloud.saved && cloud.dirty || !account.enabled || !smtp.enabled || !smtp.current || !smtp.credentialConfigured}>{mode === "direct" ? "发送普通邮件" : mode === "queued" ? "普通邮件加入队列" : "普通邮件定时发送"}</button>
    </form>
    <button className="secondary" disabled={disabled || locked || staleSource} onClick={() => void cloud.save()}>保存普通邮箱云端草稿</button>
    {(cloud.saved || cloud.error) && <button className="secondary" disabled={pending || cloud.pending || !!attempt || uploadLocked || queueLocked} onClick={() => void cloud.check()}>核对普通草稿云端版本</button>}
    {cloud.saved && <p role="status">{cloud.saved.state === "submitted" ? "此普通草稿已提交发送，请查看发送记录" : cloud.dirty ? "有未保存的修改" : `已保存到云端 · 版本 ${cloud.saved.revision}`}</p>}
    {cloud.error && <p role="alert">{cloud.error}</p>}
    {!attempt && <button className="secondary" disabled={pending || cloud.pending || uploadLocked || queueLocked} onClick={startNew}>新建普通邮件</button>}
    {attempt && <div><code>{attempt.key}</code>
      <button disabled={pending || queueLocked} onClick={() => void check()}>{attempt.kind === "job" ? "核对原普通邮件入队" : "核对原普通邮件发送"}</button>
      {attempt.maySubmit && <button disabled={disabled || pending || queueLocked} onClick={() => void submit()}>{attempt.kind === "job" ? "提交原普通邮件入队" : "提交原普通邮件发送"}</button>}
      <button className="secondary" disabled={pending || queueLocked} onClick={startNew}>另起普通邮件</button>
    </div>}
    {receipt && <p role="status">{stateText(receipt.state)}{receipt.error ? ` · ${receipt.error}` : ""}</p>}
    {job && <p role="status">{jobState(job.state)} · {dateText(job.dueAt)}</p>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    <button className="secondary" disabled={pending || queueLocked} onClick={() => void loadHistory()}>刷新普通发送记录</button>
    <ul>{history?.items.map(row => <li key={row.id}><div><strong>{row.subject || "内容已清理"}</strong>
      <small>{stateText(row.state)} · {dateText(row.createdAt)}</small><code>{row.requestKey}</code></div></li>)}</ul>
    {history?.nextCursor && <button disabled={pending || queueLocked} onClick={() => void loadHistory(true)}>更多普通发送记录</button>}
    <CloudDrafts visible revision={cloud.revision} disabled={disabled || pending || cloud.pending || !!attempt || uploadLocked || queueLocked}
      basePath={basePath} title="普通邮箱云端草稿" onOpen={id => { openingDraft.current = true; void cloud.open(id).finally(() => { openingDraft.current = false; }); }} onDelete={(id, revision) => void cloud.remove(id, revision)} />
    <SendJobs visible revision={queueRevision} basePath={`/normal-accounts/${account.id}/send-jobs`} title="普通邮箱发送队列"
      disabled={disabled || pending || cloud.pending || uploadLocked || !!attempt} onLock={reportQueue} />
  </section>;
}

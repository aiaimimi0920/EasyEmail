import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, dateText, errorMessage } from "./api";
import { waitForExtractions, type ExtractionCheck, type ExtractionResult } from "./extraction-poll";

interface Props {
  mailboxId: string; address: string; visible: boolean; usable: boolean; busy: boolean;
  onBusy: (busy: boolean) => void; onMatch: () => void;
  sourcePath?: string; cacheOnly?: boolean;
}

export function ExtractionPanel({ mailboxId, address, visible, usable, busy, onBusy, onMatch, sourcePath, cacheOnly = false }: Props) {
  const form = useRef<HTMLFormElement>(null), current = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<"cache" | "wait" | null>(null);
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [status, setStatus] = useState(""), [error, setError] = useState("");
  const path = sourcePath ?? `/mailboxes/${mailboxId}/extractions`;

  const stop = useCallback(() => {
    if (!current.current) return;
    current.current.abort(); current.current = null;
    setMode(null); setStatus("已停止等待");
  }, []);
  useEffect(() => { if (!visible || !usable) stop(); }, [visible, usable, stop]);
  useEffect(() => () => { current.current?.abort(); current.current = null; }, []);
  useEffect(() => { onBusy(mode !== null); return () => onBusy(false); }, [mode, onBusy]);

  async function search(wait: boolean) {
    if (!form.current || current.current || busy || !visible || (wait && (!usable || cacheOnly))) return;
    const data = new FormData(form.current);
    const since = wait ? Math.floor(Date.now() / 1000) : Math.floor(new Date(String(data.get("since"))).getTime() / 1000);
    const query = { since, sender: String(data.get("sender")), subject: String(data.get("subject")), recipient: address, kind: String(data.get("kind")) };
    const controller = new AbortController(); current.current = controller;
    setMode(wait ? "wait" : "cache"); setResult(null); setError("");
    setStatus(wait ? `等待开始：${dateText(since)}，最多 60 秒 / 12 次` : "");
    try {
      if (wait) {
        const outcome = await waitForExtractions((page, signal) => api<ExtractionCheck>(`${path}/check`, "POST", { ...query, page }, undefined, signal),
          controller.signal, (value, attempt) => {
            if (current.current === controller) {
              setResult(value); setStatus(`等待开始：${dateText(since)}，第 ${attempt}/12 次检查`);
            }
          });
        if (current.current !== controller) return;
        setStatus(outcome.state === "matched" ? "已找到匹配结果" : "本轮等待已结束，尚未找到匹配结果");
        if (outcome.state === "matched") onMatch();
      } else {
        const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
        const value = await api<ExtractionResult>(`${path}?${params}`, "GET", undefined, undefined, controller.signal);
        if (current.current !== controller) return;
        setResult(value); setStatus(value.items.length ? "已提取缓存结果" : "没有匹配的新验证码或链接");
      }
    } catch (failure) {
      if (current.current === controller && !controller.signal.aborted) { setError(errorMessage(failure)); setStatus(""); }
    } finally {
      if (current.current === controller) { current.current = null; setMode(null); }
    }
  }

  function extract(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void search(false); }
  return <section aria-label="验证码与认证链接">
    <form ref={form} onSubmit={extract}><h3>验证码与认证链接</h3>
      <fieldset disabled={mode !== null || busy}><div className="row">
        <label>缓存收件时间起点<input name="since" type="datetime-local" required
          defaultValue={new Date(Date.now() - 15 * 60000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)} /></label>
        <label>发件人包含<input name="sender" maxLength={320} /></label>
        <label>主题包含<input name="subject" maxLength={256} /></label>
        <label>提取目标<select name="kind"><option value="any">验证码或认证链接</option><option value="otp">验证码</option><option value="link">认证链接</option></select></label>
        <button>提取缓存邮件</button>
        {!cacheOnly && <button type="button" disabled={!usable} onClick={() => search(true)}>等待新结果（60 秒）</button>}
      </div></fieldset>
    </form>
    {mode === "wait" && <button className="secondary" onClick={stop}>停止等待</button>}
    {status && <p role="status">{status}</p>}
    {error && <p role="alert">{error}</p>}
    {result?.searchLimited && <p role="status">仅检查最近 {cacheOnly ? 10 : 100} 封缓存邮件，结果可能不完整</p>}
    {result?.sync.complete === false && <p role="status">上游同步尚不完整，未匹配不代表邮箱中没有结果</p>}
    {result?.items.map((item) => <div key={item.messageId} className="extraction">
      <small>收件时间：{dateText(item.receivedAt)}</small>
      {item.otp && <p>验证码：<code data-testid="otp-code">{item.otp.code}</code></p>}
      {item.links.map((link) => <p key={link.url}><code>{link.url}</code></p>)}
    </div>)}
  </section>;
}

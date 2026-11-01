import { useEffect, useState } from "react";
import { api, ApiError, dateText, errorMessage, type Page } from "./api";
import { type Audit, type Overview, type ProviderState } from "./admin-api";
import { ProviderEditor } from "./ProviderEditor";

const labels: Record<string, string> = {
  users: "用户", mailboxes: "邮箱", messages: "保留邮件", outgoing: "发送请求", providers: "供应商实例",
  allocationsPerUser: "每用户累计分配", allocationRequestsPerMinute: "每用户每分钟分配请求", syncRequestsPerMinute: "每用户每分钟同步请求",
  sendUserMinute: "每用户每分钟发送", sendUserUtcDay: "每用户每日发送（UTC）", sendPlatformMinute: "平台每分钟发送", sendPlatformUtcDay: "平台每日发送（UTC）",
  attachmentBytes: "单附件字节上限", jsonRequestBytes: "JSON 请求字节上限",
  environment: "部署环境", stored: "平台加密存储", none: "无凭据", ok: "通过", error: "失败", unknown: "未确认",
};

export function Administration() {
  const [providers, setProviders] = useState<ProviderState[]>([]), [overview, setOverview] = useState<Overview | null>(null);
  const [audit, setAudit] = useState<Page<Audit>>({ items: [], nextCursor: null });
  const [editing, setEditing] = useState<ProviderState | null | undefined>();
  const [pending, setPending] = useState(true), [error, setError] = useState(""), [status, setStatus] = useState("");

  async function load() {
    const [list, counts, events] = await Promise.all([api<{ items: ProviderState[] }>("/admin/providers"),
      api<Overview>("/admin/overview"), api<Page<Audit>>("/admin/audit")]);
    setProviders(list.items); setOverview(counts); setAudit(events);
  }
  useEffect(() => { load().catch((failure) => setError(errorMessage(failure))).finally(() => setPending(false)); }, []);

  async function action(task: () => Promise<void>) {
    setPending(true); setError(""); setStatus("");
    try { await task(); } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  async function probe(id: string) {
    const result = await api<{ health: ProviderState["health"] }>(`/admin/providers/${id}/probe`, "POST", {});
    await load(); setStatus(result.health.state === "ok" ? `${id}：接口探测通过` : `${id}：${errorMessage(new ApiError(502, result.health.error ?? "provider_unavailable"))}`);
  }

  return <section aria-label="平台管理">
    <h2>平台管理</h2>
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    <div className="row"><button disabled={pending || editing !== undefined} onClick={() => setEditing(null)}>新增供应商</button>
      <button className="secondary" disabled={pending || editing !== undefined} onClick={() => action(load)}>刷新管理数据</button></div>
    {editing !== undefined && <ProviderEditor key={editing?.config.id ?? "new"} initial={editing} onCancel={() => setEditing(undefined)}
      onSaved={() => { setEditing(undefined); action(async () => { await load(); setStatus("供应商配置已保存"); }); }} />}
    <ul aria-label="供应商实例">{providers.map((row) => <li key={row.config.id}>
      <div><strong>{row.config.id}</strong><small>{row.config.type} · {row.config.enabled ? "已启用" : "已停用"} · 版本 {row.revision}</small>
        <small>{row.config.baseUrl}</small><small>域名：{row.config.domains.join(", ") || "上游可用域名"}</small>
        {["duckmail", "guerrillamail"].includes(row.config.type) && <small>上游访问：{row.config.authentication === "anonymous" ? "公共匿名接口" : "平台 API Key"}</small>}
        <small>凭据：{row.secret.configured ? "已配置" : "未配置"} · {labels[row.secret.source]}</small>
        <small>探测：{labels[row.health.state] ?? row.health.state} · {dateText(row.health.checkedAt)}{row.health.error ? ` · ${row.health.error}` : ""}</small>
        <small>新分配：{row.allocation.state === "disabled" ? "已停用" : row.allocation.state === "cooling" ? `冷却至 ${dateText(row.allocation.cooldownUntil)}` : row.allocation.state === "unconfigured" ? "未配置凭据" : "可选"}</small>
        {row.allocation.lastError && <small>分配错误：{row.allocation.lastError} · 已采纳失败 {row.allocation.failureCount}</small>}</div>
      <div className="row"><button className="secondary" disabled={pending || editing !== undefined} onClick={() => setEditing(row)} aria-label={`编辑 ${row.config.id}`}>编辑</button>
        <button className="secondary" disabled={pending || editing !== undefined} onClick={() => action(() => probe(row.config.id))} aria-label={`探测 ${row.config.id}`}>接口探测</button></div>
    </li>)}</ul>
    {overview && <section className="card"><h3>平台用量</h3><dl>{Object.entries(overview.counts).map(([key, value]) => <div key={key}><dt>{labels[key] ?? key}</dt><dd>{value}</dd></div>)}</dl>
      <h3>当前硬配额（只读）</h3><dl>{Object.entries(overview.limits).filter(([key]) => key !== "readOnly").map(([key, value]) => <div key={key}><dt>{labels[key] ?? key}</dt><dd>{String(value)}</dd></div>)}</dl></section>}
    <section className="card"><h3>管理审计</h3><ul>{audit.items.map((row) => <li key={row.id}><div>{row.providerId} · {row.action} · 版本 {row.revision}
      <small>{dateText(row.createdAt)} · {row.actorId}{row.secretAction ? ` · ${row.secretAction}` : ""}{row.error ? ` · ${row.error}` : ""}</small></div></li>)}</ul>
      {audit.nextCursor && <button className="secondary" disabled={pending} onClick={() => action(async () => {
        const next = await api<Page<Audit>>(`/admin/audit?cursor=${encodeURIComponent(audit.nextCursor!)}`);
        setAudit({ items: [...audit.items, ...next.items], nextCursor: next.nextCursor });
      })}>更多审计</button>}</section>
  </section>;
}

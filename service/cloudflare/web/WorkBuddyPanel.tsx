import { Button, ButtonLink, Field, Input, Notice, Panel, Select } from '@neuro/ui';
import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { useConfirmation } from "./Confirmation";
import { SafeMailBody } from "./SafeMailBody";

interface WorkBuddyAccountDto {
  id: string;
  aliasId: string;
  emailAddress: string;
  displayName: string;
  domain: string;
  mailboxStatus: string;
  dailyQuota: { limit: number; remaining: number; reset: number; hasQuota: boolean };
  revision: number;
}

interface WorkBuddySummary {
  messageId: string;
  subject: string;
  from: string;
  to: string[];
  snippet: string;
  createdAt: string;
  isRead: boolean;
  hasAttachments: boolean;
}

interface WorkBuddyDetail {
  messageId: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  createdAt: string;
  plainText: string;
  sanitizedHtml: string;
  attachments: Array<{ attachmentId: string; filename: string; size: number; contentType: string }>;
}

export function WorkBuddyPanel() {
  const [accounts, setAccounts] = useState<WorkBuddyAccountDto[]>([]);
  const [selected, setSelected] = useState<WorkBuddyAccountDto | null>(null);
  const [authSession, setAuthSession] = useState<{ state: string; authUrl: string } | null>(null);
  const [dir, setDir] = useState<"inbox" | "sent">("inbox");
  const [keyword, setKeyword] = useState("");
  const [messages, setMessages] = useState<WorkBuddySummary[]>([]);
  const [detail, setDetail] = useState<WorkBuddyDetail | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const confirm = useConfirmation([selected?.id, detail?.messageId]);

  async function loadAccounts() {
    setError("");
    try {
      const res = await api<{ items: WorkBuddyAccountDto[] }>("/workbuddy/accounts");
      setAccounts(res.items);
      if (res.items.length > 0 && !selected) setSelected(res.items[0]!);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  useEffect(() => {
    void loadAccounts();
  }, []);

  useEffect(() => {
    if (!selected) return;
    void loadMessages(selected.id, dir, keyword);
  }, [selected?.id, dir]);

  async function loadMessages(accountId: string, nextDir: "inbox" | "sent", q: string) {
    setPending(true);
    setError("");
    try {
      const qs = new URLSearchParams({ dir: nextDir });
      if (q.trim()) qs.set("q", q.trim());
      const res = await api<{ items: WorkBuddySummary[] }>(`/workbuddy/accounts/${accountId}/messages?${qs.toString()}`);
      setMessages(res.items);
      setDetail(null);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function startAuth() {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const res = await api<{ auth: { state: string; authUrl: string } }>("/workbuddy/auth/start", "POST", {});
      setAuthSession(res.auth);
      setNotice("请点击下方按钮在浏览器完成 WorkBuddy 官方授权，授权后点击「检查授权结果」");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function pollAuth() {
    if (!authSession) return;
    setPending(true);
    setError("");
    try {
      const res = await api<{ stage: string; account?: WorkBuddyAccountDto }>("/workbuddy/auth/poll", "POST", {
        state: authSession.state,
      });
      if (res.stage === "authorized" && res.account) {
        setAuthSession(null);
        setNotice(`已接入 WorkBuddy 专属智能体邮箱：${res.account.emailAddress}`);
        await loadAccounts();
        setSelected(res.account);
      } else {
        setNotice("浏览器授权尚未完成，请在完成授权后再次点击检查");
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function openDetail(msg: WorkBuddySummary) {
    if (!selected) return;
    setPending(true);
    setError("");
    try {
      const res = await api<{ message: WorkBuddyDetail }>(
        `/workbuddy/accounts/${selected.id}/messages/${encodeURIComponent(msg.messageId)}`,
      );
      setDetail(res.message);
      if (!msg.isRead) {
        void api(`/workbuddy/accounts/${selected.id}/messages/${encodeURIComponent(msg.messageId)}/read`, "POST", {});
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function removeMessage(messageId: string) {
    if (!selected) return;
    setPending(true);
    setError("");
    try {
      const step1 = await api<{
        result: { needsConfirmation: boolean; confirmationToken?: string; deleted: boolean };
      }>(`/workbuddy/accounts/${selected.id}/messages/${encodeURIComponent(messageId)}`, "DELETE");
      if (step1.result.needsConfirmation && step1.result.confirmationToken) {
        if (!(await confirm("WorkBuddy 服务端要求二次确认永久删除该智能体邮件，确认继续删除？"))) return;
        await api(
          `/workbuddy/accounts/${selected.id}/messages/${encodeURIComponent(messageId)}?confirmationToken=${encodeURIComponent(step1.result.confirmationToken)}`,
          "DELETE",
        );
      }
      setNotice("已删除该 WorkBuddy 邮件");
      setDetail(null);
      await loadMessages(selected.id, dir, keyword);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <Panel className="card" aria-label="WorkBuddy 智能体邮箱">
      <h2>WorkBuddy 专属智能体邮箱（独立通道隔离）</h2>
      <p>通过官方网关直连收信与管理，凭据存于加密保险箱，与普通人类 SMTP 发信队列严格隔离。</p>
      {error && <Notice role="alert" tone="danger">{error}</Notice>}
      {notice && <Notice role="status" tone="info">{notice}</Notice>}
      <div className="row">
        <Button type="button" variant="primary" disabled={pending} onClick={() => void startAuth()} wrap>
          连接 WorkBuddy 智能体邮箱
        </Button>
        {authSession && (
          <>
            <ButtonLink href={authSession.authUrl} target="_blank" rel="noopener noreferrer" variant="quiet">
              打开浏览器完成授权
            </ButtonLink>
            <Button type="button" variant="quiet" disabled={pending} onClick={() => void pollAuth()} wrap>
              检查授权结果
            </Button>
          </>
        )}
      </div>

      {accounts.length > 0 && (
        <div className="row">
          <Select
            aria-label="选择 WorkBuddy 邮箱"
            value={selected?.id ?? ""}
            onChange={(e) => setSelected(accounts.find((a) => a.id === e.target.value) ?? null)}
          >
            {accounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {acc.emailAddress} ({acc.mailboxStatus})
              </option>
            ))}
          </Select>
          {selected?.dailyQuota.hasQuota && (
            <small>
              今日网关配额：剩余 {selected.dailyQuota.remaining} / {selected.dailyQuota.limit}
            </small>
          )}
          {selected && (
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={async () => {
                if (await confirm(`移除 WorkBuddy 账号 ${selected.emailAddress} 的本地加密授权？`)) {
                  await api(`/workbuddy/accounts/${selected.id}`, "DELETE");
                  setSelected(null);
                  await loadAccounts();
                }
              }}
              wrap
            >
              解绑账号
            </Button>
          )}
        </div>
      )}

      {selected && (
        <section aria-label="WorkBuddy 邮件列表">
          <div className="row">
            <Button
              type="button"
              variant="quiet"
              aria-pressed={dir === "inbox"}
              onClick={() => setDir("inbox")}
              wrap
            >
              收件箱
            </Button>
            <Button
              type="button"
              variant="quiet"
              aria-pressed={dir === "sent"}
              onClick={() => setDir("sent")}
              wrap
            >
              已发送
            </Button>
            <Field label="搜索邮件">
              <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="关键词搜索…" />
            </Field>
            <Button
              type="button"
              variant="quiet"
              disabled={pending}
              onClick={() => void loadMessages(selected.id, dir, keyword)}
              wrap
            >
              刷新／搜索
            </Button>
          </div>
          <ul>
            {messages.map((msg) => (
              <li key={msg.messageId}>
                <Button type="button" variant="quiet" onClick={() => void openDetail(msg)} wrap>
                  {msg.subject || "（无主题）"}
                </Button>
                <small>
                  {" "}
                  · {msg.from} · {msg.createdAt}
                </small>
              </li>
            ))}
          </ul>
          {messages.length === 0 && <p>暂无邮件</p>}
        </section>
      )}

      {selected && detail && (
        <article aria-label="WorkBuddy 邮件详情">
          <h3>{detail.subject || "（无主题）"}</h3>
          <p>
            {detail.from} → {detail.to.join(", ")}
          </p>
          <div className="row">
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={() => void removeMessage(detail.messageId)}
              wrap
            >
              删除此邮件（双步确认）
            </Button>
          </div>
          <SafeMailBody text={detail.plainText} html={detail.sanitizedHtml} sender={detail.from} />
          {detail.attachments.length > 0 && (
            <ul>
              {detail.attachments.map((att) => (
                <li key={att.attachmentId}>
                  <ButtonLink
                    href={`/api/v1/workbuddy/accounts/${selected.id}/messages/${encodeURIComponent(detail.messageId)}/attachments/${encodeURIComponent(att.attachmentId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="quiet"
                  >
                    下载附件：{att.filename} ({att.size} B)
                  </ButtonLink>
                </li>
              ))}
            </ul>
          )}
        </article>
      )}
    </Panel>
  );
}

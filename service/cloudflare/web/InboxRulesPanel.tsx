import { Button, Checkbox, Field, Input, Notice, Panel, Select } from '@neuro/ui';
import { useEffect, useState, type FormEvent } from "react";
import type {
  InboxRuleConditionField,
  InboxRuleConditionOperator,
  InboxRuleDefinition,
  InboxRuleDryRunReport,
} from "../../base/src/domain/mail-inbox-rules";
import { api, errorMessage } from "./api";
import { useConfirmation } from "./Confirmation";

export function InboxRulesPanel() {
  const [rules, setRules] = useState<InboxRuleDefinition[]>([]);
  const [blocklist, setBlocklist] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [field, setField] = useState<InboxRuleConditionField>("sender_domain");
  const [operator, setOperator] = useState<InboxRuleConditionOperator>("contains");
  const [value, setValue] = useState("");
  const [markRead, setMarkRead] = useState(true);
  const [star, setStar] = useState(false);
  const [archive, setArchive] = useState(false);
  const [blockPattern, setBlockPattern] = useState("");
  const [dryRun, setDryRun] = useState<InboxRuleDryRunReport | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const confirm = useConfirmation([rules.length, dryRun?.matchedCount]);

  async function refresh() {
    setError("");
    try {
      const res = await api<{ items: InboxRuleDefinition[]; blocklist: string[] }>("/inbox-rules");
      setRules(res.items);
      setBlocklist(res.blocklist);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createRule(e: FormEvent) {
    e.preventDefault();
    if (pending || !name.trim() || !value.trim()) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const res = await api<{ items: InboxRuleDefinition[] }>("/inbox-rules", "POST", {
        name: name.trim(),
        enabled: true,
        priority: (rules.length + 1) * 10,
        matchMode: "all",
        stopMatching: true,
        conditions: [{ field, operator, value: value.trim() }],
        actions: { markRead, star, archive },
      });
      setRules(res.items);
      setName("");
      setValue("");
      setNotice("已保存收件规则");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function runDryRun() {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const res = await api<{ report: InboxRuleDryRunReport }>("/inbox-rules/dry-run", "POST", {
        windowDays: 30,
      });
      setDryRun(res.report);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function applyRules() {
    if (!(await confirm("确认将已启用的规则动作应用到最近 30 天内匹配的平台缓存邮件？"))) return;
    setPending(true);
    setError("");
    try {
      const res = await api<{ appliedCount: number; report: InboxRuleDryRunReport }>(
        "/inbox-rules/apply",
        "POST",
        {},
      );
      setDryRun(res.report);
      setNotice(`已安全应用规则至 ${res.appliedCount} 封匹配邮件`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function addBlockDomain(e: FormEvent) {
    e.preventDefault();
    if (!blockPattern.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      const res = await api<{ blocklist: string[] }>("/inbox-rules/blocklist", "POST", {
        pattern: blockPattern.trim(),
      });
      setBlocklist(res.blocklist);
      setBlockPattern("");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <Panel className="card" aria-label="收件规则与 Dry-Run 预览">
      <h2>多条件收件规则与 30 天只读 Dry-Run 预览</h2>
      {error && <Notice role="alert" tone="danger">{error}</Notice>}
      {notice && <Notice role="status" tone="info">{notice}</Notice>}

      <form onSubmit={(e) => void createRule(e)}>
        <Field label="规则名称">
          <Input value={name} maxLength={120} required disabled={pending} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="row">
          <Field label="匹配字段">
            <Select value={field} disabled={pending} onChange={(e) => setField(e.target.value as InboxRuleConditionField)}>
              <option value="sender_domain">发件域名（含子域）</option>
              <option value="sender">发件地址</option>
              <option value="subject">邮件主题</option>
              <option value="body">正文摘要</option>
              <option value="attachment_ext">附件后缀</option>
            </Select>
          </Field>
          <Field label="匹配方式">
            <Select value={operator} disabled={pending} onChange={(e) => setOperator(e.target.value as InboxRuleConditionOperator)}>
              <option value="contains">包含</option>
              <option value="equals">精确等于</option>
              <option value="ends_with">后缀匹配</option>
              <option value="not_contains">不包含</option>
            </Select>
          </Field>
          <Field label="匹配值">
            <Input value={value} maxLength={160} required disabled={pending} onChange={(e) => setValue(e.target.value)} />
          </Field>
        </div>
        <div className="row">
          <Checkbox checked={markRead} disabled={pending} onChange={(e) => setMarkRead(e.target.checked)} label="自动标为已读" />
          <Checkbox checked={star} disabled={pending} onChange={(e) => setStar(e.target.checked)} label="自动加星标" />
          <Checkbox checked={archive} disabled={pending} onChange={(e) => setArchive(e.target.checked)} label="自动归档" />
        </div>
        <Button type="submit" variant="primary" disabled={pending} wrap>
          新增收件规则
        </Button>
      </form>

      <div className="row">
        <Button type="button" variant="quiet" disabled={pending || rules.length === 0} onClick={() => void runDryRun()} wrap>
          运行 30 天只读 Dry-Run 预览
        </Button>
        {dryRun && dryRun.matchedCount > 0 && (
          <Button type="button" variant="quiet" disabled={pending} onClick={() => void applyRules()} wrap>
            对匹配的 {dryRun.matchedCount} 封邮件执行规则
          </Button>
        )}
      </div>

      {dryRun && (
        <section aria-label="Dry-Run 预览报告">
          <Notice role="status" tone="info">
            只读预览：扫描最近 {dryRun.windowDays} 天内 {dryRun.scannedCount} 封缓存邮件，命中 {dryRun.matchedCount} 封（未修改任何数据）。
          </Notice>
          <ul>
            {dryRun.matches.map((m) => (
              <li key={m.messageId}>
                <strong>{m.subject || "（无主题）"}</strong> <small>· {m.sender}</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ul>
        {rules.map((r) => (
          <li key={r.id}>
            <strong>{r.name}</strong>{" "}
            <small>
              （优先级 {r.priority} · 条件数 {r.conditions.length}）
            </small>{" "}
            <Button
              type="button"
              variant="quiet"
              disabled={pending}
              onClick={async () => {
                await api(`/inbox-rules/${r.id}`, "DELETE");
                await refresh();
              }}
              wrap
            >
              删除规则
            </Button>
          </li>
        ))}
      </ul>

      <form className="row" onSubmit={(e) => void addBlockDomain(e)}>
        <Field label="域名／发件人黑名单（自动匹配子域）">
          <Input value={blockPattern} placeholder="spam.example.com" onChange={(e) => setBlockPattern(e.target.value)} />
        </Field>
        <Button type="submit" variant="quiet" disabled={pending} wrap>
          加入黑名单
        </Button>
      </form>
      {blocklist.length > 0 && (
        <ul>
          {blocklist.map((pat) => (
            <li key={pat}>
              <code>{pat}</code>{" "}
              <Button
                type="button"
                variant="quiet"
                disabled={pending}
                onClick={async () => {
                  const res = await api<{ blocklist: string[] }>("/inbox-rules/blocklist", "DELETE", { pattern: pat });
                  setBlocklist(res.blocklist);
                }}
                wrap
              >
                移除
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

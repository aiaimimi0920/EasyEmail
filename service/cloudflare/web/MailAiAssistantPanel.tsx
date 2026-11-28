import { Button, Checkbox, Disclosure, Notice, Select } from '@neuro/ui';
import { useEffect, useMemo, useState } from "react";
import { evaluateMailPrivacyGuard } from "../../base/src/domain/mail-ai-privacy-guard";
import { api, errorMessage } from "./api";

interface SummaryData {
  summaryTitle: string;
  summary: string;
  deadlines: Array<{ label: string; timeText: string; urgent: boolean }>;
}

interface DraftData {
  draftReply: string;
  draftTag: string;
}

export function MailAiAssistantPanel({
  subject,
  text,
  html,
  securityLevel,
}: {
  subject?: string;
  text: string;
  html: string;
  securityLevel?: "safe" | "warning" | "danger";
}) {
  const [consentChecked, setConsentChecked] = useState(false);
  const [tone, setTone] = useState<"formal" | "friendly">("formal");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [copiedNotice, setCopiedNotice] = useState("");
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [draft, setDraft] = useState<DraftData | null>(null);

  useEffect(() => {
    setSummary(null);
    setDraft(null);
    setError("");
    setCopiedNotice("");
    setConsentChecked(false);
  }, [subject, text, html]);

  const localGuard = useMemo(
    () =>
      evaluateMailPrivacyGuard(
        {
          enabled: true,
          includeSubject: true,
          requireExplicitConsent: false,
          provider: "openai",
          endpointUrl: "https://api.openai.com/v1",
        },
        {
          subject,
          textBody: text,
          htmlBody: html,
          phishingLevel: securityLevel,
          consentConfirmed: true,
        },
      ),
    [subject, text, html, securityLevel],
  );

  async function executeTask(task: "summary" | "draft") {
    setPending(true);
    setError("");
    setCopiedNotice("");
    try {
      const resp = await api<{
        result:
          | ({ kind: "summary" } & SummaryData)
          | ({ kind: "draft" } & DraftData);
      }>("/ai/analyze", "POST", {
        task,
        subject,
        text,
        html,
        securityLevel,
        tone,
        consentConfirmed: consentChecked,
      });
      if (resp.result.kind === "summary") {
        setSummary(resp.result);
      } else if (resp.result.kind === "draft") {
        setDraft(resp.result);
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function copyDraft() {
    if (!draft?.draftReply) return;
    try {
      await navigator.clipboard.writeText(draft.draftReply);
      setCopiedNotice("已复制 AI 回复草稿到剪贴板，粘贴后请人工核对再发送");
    } catch {
      setCopiedNotice("请手动选中并复制下方草稿正文");
    }
  }

  return (
    <Disclosure title="AI 邮件摘要与回复起草（PrivacyGuard 保护）">
      {!localGuard.allowed ? (
        <Notice role="status" tone="warning">
          {localGuard.reason}
        </Notice>
      ) : (
        <div>
          <p>
            仅发送清洗后的可见正文（约 {localGuard.preview.charCount} 字符，已自动脱敏邮箱／手机号／卡号，绝不附带原始邮件头或附件）。
          </p>
          <Checkbox
            checked={consentChecked}
            disabled={pending}
            onChange={(e) => setConsentChecked(e.target.checked)}
            label="我已知悉并同意将脱敏后的可见正文发送至我配置的 BYOK 模型服务"
          />
          <div className="row">
            <Button
              type="button"
              variant="quiet"
              disabled={pending || !consentChecked}
              onClick={() => void executeTask("summary")}
              wrap
            >
              {pending ? "生成中…" : "生成要点摘要与待办"}
            </Button>
            <Select
              aria-label="回复语气"
              value={tone}
              disabled={pending}
              onChange={(e) => setTone(e.target.value as "formal" | "friendly")}
            >
              <option value="formal">正式语气草稿</option>
              <option value="friendly">友好语气草稿</option>
            </Select>
            <Button
              type="button"
              variant="quiet"
              disabled={pending || !consentChecked}
              onClick={() => void executeTask("draft")}
              wrap
            >
              起草回复（不自动发送）
            </Button>
          </div>
          {error && <Notice role="alert" tone="danger">{error}</Notice>}
          {summary && (
            <div role="region" aria-label="AI 邮件摘要结果">
              <strong>{summary.summaryTitle}</strong>
              <p>{summary.summary}</p>
              {summary.deadlines.length > 0 && (
                <ul>
                  {summary.deadlines.map((d, idx) => (
                    <li key={`${d.label}:${idx}`}>
                      {d.urgent ? "[紧急] " : ""}
                      {d.label} {d.timeText ? `（${d.timeText}）` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {draft && (
            <div role="region" aria-label="AI 回复草稿结果">
              <div className="row">
                <strong>建议回复草稿（{draft.draftTag}）</strong>
                <Button type="button" variant="quiet" onClick={() => void copyDraft()} wrap>
                  复制草稿文本
                </Button>
              </div>
              <pre>{draft.draftReply}</pre>
              {copiedNotice && <Notice role="status" tone="info">{copiedNotice}</Notice>}
            </div>
          )}
        </div>
      )}
    </Disclosure>
  );
}

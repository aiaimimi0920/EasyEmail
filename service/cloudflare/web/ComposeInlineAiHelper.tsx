import { Button, Checkbox, Disclosure, Notice } from '@neuro/ui';
import { useState } from "react";
import { api, errorMessage } from "./api";

export function ComposeInlineAiHelper({
  text,
  disabled,
  onApplyPolished,
}: {
  text: string;
  disabled?: boolean;
  onApplyPolished: (nextText: string) => void;
}) {
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("");

  async function polishDraft() {
    if (!text.trim()) {
      setError("请先输入草稿正文后再使用 AI 润色");
      return;
    }
    setPending(true);
    setError("");
    try {
      const resp = await api<{ result: { kind: "polish"; polishedText: string } }>(
        "/ai/analyze",
        "POST",
        {
          task: "polish",
          text,
          consentConfirmed: consent,
        },
      );
      setPreview(resp.result.polishedText);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <Disclosure title="AI 写信润色助手（仅填入草稿，绝不自动发送）">
      <Checkbox
        checked={consent}
        disabled={disabled || pending}
        onChange={(e) => setConsent(e.target.checked)}
        label="确认将当前草稿脱敏后发送至已配置的 BYOK 模型润色"
      />
      <div className="row">
        <Button
          type="button"
          variant="quiet"
          disabled={disabled || pending || !consent || !text.trim()}
          onClick={() => void polishDraft()}
          wrap
        >
          {pending ? "润色中…" : "生成润色建议"}
        </Button>
        {preview && (
          <Button
            type="button"
            variant="primary"
            disabled={disabled || pending}
            onClick={() => {
              onApplyPolished(preview);
              setPreview("");
            }}
            wrap
          >
            应用润色文本到草稿
          </Button>
        )}
      </div>
      {error && <Notice role="alert" tone="danger">{error}</Notice>}
      {preview && <pre aria-label="AI 润色预览">{preview}</pre>}
    </Disclosure>
  );
}

import { Button, Checkbox, Field, Input, Notice, Panel, Select } from '@neuro/ui';
import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage } from "./api";

interface AiConfigDto {
  enabled: boolean;
  provider: "openai" | "deepseek" | "claude" | "gemini" | "ollama" | "custom";
  endpointUrl: string;
  modelName: string;
  credentialConfigured: boolean;
  includeSubject: boolean;
  requireConsent: boolean;
  translationEnabled: boolean;
  translationProvider: "byok" | "free";
  translationTargetLang: string;
  freeTranslateAvailable: boolean;
  revision: number;
}

const PROVIDER_DEFAULTS: Record<string, { endpointUrl: string; modelName: string }> = {
  openai: { endpointUrl: "https://api.openai.com/v1", modelName: "gpt-4o-mini" },
  deepseek: { endpointUrl: "https://api.deepseek.com/v1", modelName: "deepseek-chat" },
  claude: { endpointUrl: "https://api.anthropic.com/v1", modelName: "claude-3-5-haiku-latest" },
  gemini: { endpointUrl: "https://generativelanguage.googleapis.com/v1beta", modelName: "gemini-2.5-flash" },
};

export function AiSettingsPanel() {
  const [config, setConfig] = useState<AiConfigDto | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    api<{ config: AiConfigDto }>("/ai/config")
      .then((res) => {
        if (active) setConfig(res.config);
      })
      .catch((failure) => {
        if (active) setError(errorMessage(failure));
      });
    return () => {
      active = false;
    };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!config || pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const res = await api<{ config: AiConfigDto }>("/ai/config", "PUT", {
        enabled: config.enabled,
        provider: config.provider,
        endpointUrl: config.endpointUrl,
        modelName: config.modelName,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        includeSubject: config.includeSubject,
        requireConsent: config.requireConsent,
        translationEnabled: config.translationEnabled,
        translationProvider: config.translationProvider,
        translationTargetLang: config.translationTargetLang,
        expectedRevision: config.revision,
      });
      setConfig(res.config);
      setApiKey("");
      setNotice("AI 与保真翻译配置已加密保存");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function testModel() {
    if (pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const res = await api<{ ok: boolean; latencyMs: number; sample: string }>("/ai/test", "POST", {});
      setNotice(`模型连接测试成功（耗时 ${res.latencyMs} ms，响应：${res.sample}）`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  if (!config) {
    return (
      <Panel className="card" aria-label="AI 与翻译设置">
        <h2>AI 与翻译设置</h2>
        {error ? <Notice role="alert" tone="danger">{error}</Notice> : <Notice role="status" tone="info">读取配置中…</Notice>}
      </Panel>
    );
  }

  return (
    <Panel className="card" aria-label="AI 与翻译设置">
      <h2>AI 与翻译设置（BYOK 加密保险箱 + PrivacyGuard）</h2>
      <p>
        所有外部 AI 调用均受五步 PrivacyGuard 保护：验证码、密码重置、私钥凭据与高危钓鱼邮件会被强制本地拦截；普通邮件在发往外部模型前自动脱敏个人敏感信息。
      </p>
      {error && <Notice role="alert" tone="danger">{error}</Notice>}
      {notice && <Notice role="status" tone="info">{notice}</Notice>}
      <form onSubmit={(e) => void save(e)}>
        <Checkbox
          checked={config.enabled}
          disabled={pending}
          onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
          label="启用 BYOK AI 摘要、回复起草与写信润色"
        />
        <Field label="模型服务商">
          <Select
            value={config.provider}
            disabled={pending}
            onChange={(e) => {
              const provider = e.target.value as AiConfigDto["provider"];
              const preset = PROVIDER_DEFAULTS[provider];
              setConfig({
                ...config,
                provider,
                ...(preset ? preset : {}),
              });
            }}
          >
            <option value="openai">OpenAI / 兼容接口</option>
            <option value="deepseek">DeepSeek</option>
            <option value="claude">Anthropic Claude</option>
            <option value="gemini">Google Gemini</option>
            <option value="custom">自定义 HTTPS 兼容端点</option>
          </Select>
        </Field>
        <Field label="HTTPS 模型端点 URL">
          <Input
            value={config.endpointUrl}
            disabled={pending}
            required
            onChange={(e) => setConfig({ ...config, endpointUrl: e.target.value })}
          />
        </Field>
        <Field label="模型名称">
          <Input
            value={config.modelName}
            disabled={pending}
            required
            onChange={(e) => setConfig({ ...config, modelName: e.target.value })}
          />
        </Field>
        <Field label={config.credentialConfigured ? "更新 API Key（已加密保存，留空保持不变）" : "API Key（AES-GCM 保险箱加密存储）"}>
          <Input
            type="password"
            value={apiKey}
            disabled={pending}
            placeholder={config.credentialConfigured ? "••••••••（已保存）" : "sk-..."}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Field>
        <Checkbox
          checked={config.includeSubject}
          disabled={pending}
          onChange={(e) => setConfig({ ...config, includeSubject: e.target.checked })}
          label="允许将脱敏后的邮件主题包含在 AI 摘要上下文中"
        />
        <Checkbox
          checked={config.requireConsent}
          disabled={pending}
          onChange={(e) => setConfig({ ...config, requireConsent: e.target.checked })}
          label="每次向外部模型发送正文前要求显式勾选外发知情同意"
        />
        <Checkbox
          checked={config.translationEnabled}
          disabled={pending}
          onChange={(e) => setConfig({ ...config, translationEnabled: e.target.checked })}
          label="启用阅读器 DOM 保真段落翻译（原文／译文／双语对照）"
        />
        <Field label="翻译通道">
          <Select
            value={config.translationProvider}
            disabled={pending}
            onChange={(e) => setConfig({ ...config, translationProvider: e.target.value as "byok" | "free" })}
          >
            <option value="byok">使用上方已配置的 BYOK 模型翻译</option>
            <option value="free">
              使用平台免 Key 翻译通道{config.freeTranslateAvailable ? "（已就绪）" : "（当前环境未配置）"}
            </option>
          </Select>
        </Field>
        <Field label="默认目标语言">
          <Select
            value={config.translationTargetLang}
            disabled={pending}
            onChange={(e) => setConfig({ ...config, translationTargetLang: e.target.value })}
          >
            <option value="zh-CN">简体中文 (zh-CN)</option>
            <option value="en">English (en)</option>
            <option value="ja">日本語 (ja)</option>
            <option value="ko">한국어 (ko)</option>
          </Select>
        </Field>
        <div className="row">
          <Button type="submit" variant="primary" disabled={pending} wrap>
            保存 AI 与翻译设置
          </Button>
          <Button
            type="button"
            variant="quiet"
            disabled={pending || !config.credentialConfigured}
            onClick={() => void testModel()}
            wrap
          >
            测试模型连接
          </Button>
        </div>
      </form>
    </Panel>
  );
}

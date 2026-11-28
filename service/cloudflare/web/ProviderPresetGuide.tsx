import { Button, Disclosure, Field, Notice, Select } from '@neuro/ui';
import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import type { ImapEndpoint } from "./normal-accounts";
import type { MailProviderPreset } from "../../base/src/domain/mail-provider-presets";

interface PresetItem extends MailProviderPreset {
  matchedEndpointId: string | null;
}

export function ProviderPresetGuide({ endpoints, selectedEndpointId, onSelectEndpoint }: {
  endpoints: ImapEndpoint[];
  selectedEndpointId: string;
  onSelectEndpoint(endpointId: string): void;
}) {
  const [presets, setPresets] = useState<PresetItem[]>([]);
  const [presetId, setPresetId] = useState("");
  const [detectEmail, setDetectEmail] = useState("");
  const [detectNote, setDetectNote] = useState("");
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    let active = true;
    api<{ items: PresetItem[] }>("/normal-accounts/presets")
      .then((res) => { if (active) setPresets(res.items); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const currentPreset = presets.find((item) => item.id === presetId) ?? null;

  async function detectByMx() {
    const email = detectEmail.trim();
    if (!email || detecting) return;
    setDetecting(true);
    setDetectNote("");
    try {
      const res = await api<{ preset: MailProviderPreset | null; matchedEndpointId: string | null; mxExchanges: string[] }>(
        `/normal-accounts/detect-preset?email=${encodeURIComponent(email)}`,
      );
      if (res.preset) {
        setPresetId(res.preset.id);
        if (res.matchedEndpointId && res.matchedEndpointId !== selectedEndpointId) {
          onSelectEndpoint(res.matchedEndpointId);
        }
        const mxSuffix = res.mxExchanges.length ? `（MX: ${res.mxExchanges[0]}）` : "";
        setDetectNote(`已识别为「${res.preset.name}」${mxSuffix}${res.matchedEndpointId ? "，已自动匹配平台 IMAP 服务器" : "（当前部署白名单尚未配置对应主机）"}`);
      } else {
        setDetectNote(res.mxExchanges.length ? `未命中内置预设（MX: ${res.mxExchanges.join(", ")}），请手动选择通用服务器` : "未识别到内置服务商预设，请手动选择服务器");
      }
    } catch (err) {
      setDetectNote(errorMessage(err));
    } finally {
      setDetecting(false);
    }
  }

  if (!presets.length) return null;

  return <Disclosure title="邮局预设向导与企业域 MX 自动识别（17+ 服务商 / Linux.do）">
    <div className="preset-guide">
      <Field label="选择邮局预设查看接入指引">
        <Select value={presetId} onChange={(event) => {
          const nextId = event.target.value;
          setPresetId(nextId);
          const found = presets.find((p) => p.id === nextId);
          if (found?.matchedEndpointId && endpoints.some((e) => e.id === found.matchedEndpointId)) {
            onSelectEndpoint(found.matchedEndpointId);
          }
        }}>
          <option value="">-- 查看服务商预设（个人 / Linux.do / 企业邮） --</option>
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name} · {preset.badgeText}{preset.matchedEndpointId ? "（平台已就绪）" : ""}
            </option>
          ))}
        </Select>
      </Field>
      <div className="row">
        <Button type="button" variant="quiet" disabled={detecting} onClick={() => {
          const formEmail = document.querySelector<HTMLInputElement>('input[name="emailAddress"]')?.value ?? "";
          if (formEmail) setDetectEmail(formEmail);
          const target = (formEmail || detectEmail).trim();
          if (!target) {
            setDetectNote("请先在上方「邮箱地址」输入邮箱后再点击识别");
            return;
          }
          setDetectEmail(target);
          void (async () => {
            setDetecting(true);
            setDetectNote("");
            try {
              const res = await api<{ preset: MailProviderPreset | null; matchedEndpointId: string | null; mxExchanges: string[] }>(
                `/normal-accounts/detect-preset?email=${encodeURIComponent(target)}`,
              );
              if (res.preset) {
                setPresetId(res.preset.id);
                if (res.matchedEndpointId) onSelectEndpoint(res.matchedEndpointId);
                setDetectNote(`已识别为「${res.preset.name}」${res.matchedEndpointId ? "并自动选定对应服务器" : ""}`);
              } else {
                setDetectNote("未命中内置邮局预设，请手动选择 IMAP 服务器");
              }
            } catch (err) {
              setDetectNote(errorMessage(err));
            } finally {
              setDetecting(false);
            }
          })();
        }} wrap>{detecting ? "正在查询 MX…" : "按邮箱地址 / MX 自动识别邮局"}</Button>
        {detectEmail && <Button type="button" variant="quiet" disabled={detecting} onClick={() => void detectByMx()} wrap>重新识别</Button>}
      </div>
      {detectNote && <Notice role="status" tone="info">{detectNote}</Notice>}
      {currentPreset && <div aria-label="邮局接入步骤">
        <p><strong>{currentPreset.guideTitle}</strong>：{currentPreset.guideSummary}</p>
        {currentPreset.defaultImapHost && <p><small>推荐参数：IMAP {currentPreset.defaultImapHost}:{currentPreset.defaultImapPort} ({currentPreset.defaultImapSecurity.toUpperCase()}) · SMTP {currentPreset.defaultSmtpHost}:{currentPreset.defaultSmtpPort}{currentPreset.requiresImapId ? " · 已内置网易 RFC 2971 ID 握手" : ""}</small></p>}
        <ol>{currentPreset.steps.map((step, idx) => <li key={idx}>{step}</li>)}</ol>
      </div>}
    </div>
  </Disclosure>;
}

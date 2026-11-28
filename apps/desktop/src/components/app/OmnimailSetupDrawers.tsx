import { useEffect, useState, type ChangeEvent } from "react";
import type { AppController } from "../../app/useAppController";
import { omnimailWorkbenchClient } from "../../app/appRuntime";
import type {
  DesktopAiSettingsDto,
  DesktopFourStageReportDto,
  DesktopProviderPresetDto,
} from "../../api/omnimailWorkbenchClient";
import { normalizeProviderAppSecret } from "../../../../../service/base/src/domain/mail-provider-presets";

export function OmnimailSetupDrawers({ controller }: { controller: AppController }) {
  const [presets, setPresets] = useState<DesktopProviderPresetDto[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [probeReport, setProbeReport] = useState<DesktopFourStageReportDto | null>(null);
  const [aiSettings, setAiSettings] = useState<DesktopAiSettingsDto | null>(null);
  const [aiKey, setAiKey] = useState("");
  const [ruleName, setRuleName] = useState("");
  const [ruleDomain, setRuleDomain] = useState("");
  const [dryRunSummary, setDryRunSummary] = useState<string>("");
  const [dupCount, setDupCount] = useState<number | null>(null);
  const [dupGroups, setDupGroups] = useState<
    Array<{ groupKey: string; canonicalKey: string; members: Array<{ id: string; displayName: string; emailAddress: string }> }>
  >([]);
  const [senderCandidates, setSenderCandidates] = useState<Array<{ displayName: string; emailAddress: string }>>([]);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    omnimailWorkbenchClient
      .listProviderPresets()
      .then((res) => setPresets(res.presets))
      .catch(() => {});
    omnimailWorkbenchClient
      .getAiSettings()
      .then((res) => setAiSettings(res.settings))
      .catch(() => {});
  }, []);

  function applyPreset(preset: DesktopProviderPresetDto) {
    setSelectedPresetId(preset.id);
    controller.setNormalImapHost(preset.defaultImapHost);
    controller.setNormalImapPort(String(preset.defaultImapPort));
    controller.setNormalImapSecurity(preset.defaultImapSecurity);
    controller.setNormalSmtpHost(preset.defaultSmtpHost);
    controller.setNormalSmtpPort(String(preset.defaultSmtpPort));
    controller.setNormalSmtpSecurity(preset.defaultSmtpSecurity);
    if (preset.supportsAppPassword && controller.normalImapPassword) {
      controller.updateMailboxAuthorizationCode(
        normalizeProviderAppSecret(preset.id, controller.normalImapPassword),
      );
    }
    setNotice(`已套用「${preset.name}」预设：${preset.guideSummary}`);
  }

  async function runFourStageProbe() {
    if (!controller.normalImapHost) return;
    const res = await omnimailWorkbenchClient.diagnoseConnectivity({
      emailAddress: controller.normalEmailAddress,
      imapHost: controller.normalImapHost,
      imapPort: Number(controller.normalImapPort || "993"),
      imapSecurity: controller.normalImapSecurity,
      imapUsername: controller.mailboxLoginUsername() || controller.normalEmailAddress,
      smtpHost: controller.normalSmtpHost || undefined,
      smtpPort: controller.normalSmtpPort ? Number(controller.normalSmtpPort) : undefined,
      smtpSecurity: controller.normalSmtpSecurity,
    });
    setProbeReport(res.report);
  }

  async function importVcfFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!file) return;
    const raw = await file.text();
    const res = await omnimailWorkbenchClient.importVCard(raw);
    setNotice(`已从 vCard 导入 ${res.importedCount} 位联系人`);
  }

  return (
    <div className="nt-two-column" aria-label="多邮局预设、AI 守卫与工作台增强">
      <section className="nt-action-board">
        <p className="nt-kicker">PROVIDER PRESETS & 4-STAGE DIAGNOSTICS</p>
        <div className="nt-form-grid">
          <label className="nt-wide-field">
            一键套用 18+ 主流与社区邮局预设（Linux.do / 企业邮 / Proton Bridge）
            <select
              value={selectedPresetId}
              onChange={(e) => {
                const found = presets.find((p) => p.id === e.currentTarget.value);
                if (found) applyPreset(found);
              }}
            >
              <option value="">选择邮局预设自动填入 IMAP/SMTP…</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  [{p.category}] {p.name} ({p.defaultImapHost || "专属通道"})
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="nt-row-actions">
          <button
            type="button"
            className="nt-mini-btn"
            onClick={async () => {
              if (!controller.normalEmailAddress) return;
              const det = await omnimailWorkbenchClient.listProviderPresets(controller.normalEmailAddress, true);
              if (det.detected?.preset) applyPreset(det.detected.preset);
              else setNotice("未匹配到已知 MX 邮局预设，请手动填写服务器");
            }}
          >
            智能探测域名 MX 预设
          </button>
          <button type="button" className="nt-mini-btn nt-mini-btn--signal" onClick={() => void runFourStageProbe()}>
            四阶段连接诊断 (TCP/TLS/IMAP/SMTP)
          </button>
        </div>
        {probeReport && (
          <div className="nt-result">
            <strong>{probeReport.ok ? "✓ 四阶段诊断全部通过" : probeReport.summary || "连接诊断结果"}</strong>
            {probeReport.steps.map((s) => (
              <small key={s.stage}>
                [{s.ok ? "PASS" : "CHECK"}] {s.label} ({s.durationMs}ms): {s.detail} {s.suggestion ? `— ${s.suggestion}` : ""}
              </small>
            ))}
          </div>
        )}

        <div className="nt-divider" />
        <p className="nt-kicker">INBOX RULES (30-DAY DRY-RUN) & CONTACTS VCARD</p>
        <div className="nt-form-grid">
          <label>
            规则名称
            <input value={ruleName} placeholder="自动已读通知" onChange={(e) => setRuleName(e.currentTarget.value)} />
          </label>
          <label>
            匹配发件域名
            <input value={ruleDomain} placeholder="github.com" onChange={(e) => setRuleDomain(e.currentTarget.value)} />
          </label>
        </div>
        <div className="nt-row-actions">
          <button
            type="button"
            className="nt-mini-btn"
            onClick={async () => {
              if (!ruleName.trim() || !ruleDomain.trim()) return;
              await omnimailWorkbenchClient.saveRule({
                name: ruleName.trim(),
                conditions: [{ field: "sender_domain", operator: "contains", value: ruleDomain.trim() }],
                actions: { markRead: true },
              });
              setRuleName("");
              setRuleDomain("");
              setNotice("已新增本地收件规则");
            }}
          >
            保存规则
          </button>
          <button
            type="button"
            className="nt-mini-btn"
            onClick={async () => {
              const rep = await omnimailWorkbenchClient.previewRulesDryRun(30);
              setDryRunSummary(`只读扫描 30 天内 ${rep.report.scannedCount} 封邮件，命中 ${rep.report.matchedCount} 封`);
            }}
          >
            30 天只读 Dry-Run 预览
          </button>
          <button
            type="button"
            className="nt-mini-btn"
            onClick={async () => {
              const applied = await omnimailWorkbenchClient.applyRules(30);
              setDryRunSummary(`已将启用规则与黑名单应用到 ${applied.appliedCount} 封本地缓存邮件`);
            }}
          >
            应用规则到存量邮件
          </button>
          <button
            type="button"
            className="nt-mini-btn"
            onClick={async () => {
              const res = await omnimailWorkbenchClient.listContactCandidates();
              setSenderCandidates(res.candidates);
              if (res.candidates.length === 0) setNotice("近期邮件暂无未保存的新发件人候选");
            }}
          >
            提取发件人候选
          </button>
          <button
            type="button"
            className="nt-mini-btn"
            onClick={async () => {
              const dup = await omnimailWorkbenchClient.findContactDuplicates();
              setDupGroups(dup.groups);
              setDupCount(dup.groups.length);
            }}
          >
            扫描重复联系人
          </button>
          <button
            type="button"
            className="nt-mini-btn"
            onClick={async () => {
              const res = await omnimailWorkbenchClient.exportVCard();
              const blob = new Blob([res.vcf], { type: "text/vcard;charset=utf-8" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "nmail-contacts.vcf";
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            导出 vCard (.vcf)
          </button>
          <label className="nt-mini-btn">
            导入 vCard
            <input type="file" accept=".vcf,text/vcard" hidden onChange={(e) => void importVcfFile(e)} />
          </label>
        </div>
        {dryRunSummary && <small>{dryRunSummary}</small>}
        {dupCount !== null && <small>检测到 {dupCount} 组重复或 +alias 同源联系人</small>}
        {dupGroups.map((g) => (
          <div className="nt-row-actions" key={g.groupKey}>
            <small>{g.canonicalKey}</small>
            <button
              type="button"
              className="nt-mini-btn"
              onClick={async () => {
                const primary = g.members[0];
                if (!primary) return;
                await omnimailWorkbenchClient.mergeContacts(
                  primary.id,
                  g.members.slice(1).map((m) => m.id),
                );
                const dup = await omnimailWorkbenchClient.findContactDuplicates();
                setDupGroups(dup.groups);
                setDupCount(dup.groups.length);
              }}
            >
              无损合并
            </button>
          </div>
        ))}
        {senderCandidates.slice(0, 8).map((cand) => (
          <div className="nt-row-actions" key={cand.emailAddress}>
            <small>
              {cand.displayName} ({cand.emailAddress})
            </small>
            <button
              type="button"
              className="nt-mini-btn"
              onClick={async () => {
                const vcf = ["BEGIN:VCARD", "VERSION:3.0", `FN:${cand.displayName}`, `EMAIL:${cand.emailAddress}`, "END:VCARD"].join("\r\n");
                await omnimailWorkbenchClient.importVCard(vcf);
                setSenderCandidates((prev) => prev.filter((item) => item.emailAddress !== cand.emailAddress));
                setNotice(`已添加联系人 ${cand.emailAddress}`);
              }}
            >
              加入通讯录
            </button>
          </div>
        ))}
      </section>

      <section className="nt-action-board">
        <p className="nt-kicker">BYOK AI & FIDELITY TRANSLATION (PRIVACYGUARD)</p>
        {aiSettings && (
          <div className="nt-form-grid">
            <label className="nt-check nt-wide-field">
              <input
                type="checkbox"
                checked={aiSettings.enabled}
                onChange={(e) => setAiSettings({ ...aiSettings, enabled: e.currentTarget.checked })}
              />
              启用 BYOK AI 摘要与草稿助手（支持本地 Ollama 免密直连）
            </label>
            <label>
              AI 服务商
              <select
                value={aiSettings.provider}
                onChange={(e) =>
                  setAiSettings({
                    ...aiSettings,
                    provider: e.currentTarget.value as DesktopAiSettingsDto["provider"],
                  })
                }
              >
                <option value="openai">OpenAI / 兼容</option>
                <option value="deepseek">DeepSeek</option>
                <option value="claude">Claude</option>
                <option value="gemini">Gemini</option>
                <option value="ollama">本地 Ollama (Loopback)</option>
              </select>
            </label>
            <label>
              模型名称
              <input
                value={aiSettings.modelName}
                onChange={(e) => setAiSettings({ ...aiSettings, modelName: e.currentTarget.value })}
              />
            </label>
            <label className="nt-wide-field">
              模型端点 URL
              <input
                value={aiSettings.endpointUrl}
                onChange={(e) => setAiSettings({ ...aiSettings, endpointUrl: e.currentTarget.value })}
              />
            </label>
            <label className="nt-wide-field">
              API Key（Ollama 本机可留空）
              <input
                type="password"
                value={aiKey}
                placeholder={aiSettings.credentialConfigured ? "已配置（留空保持不变）" : "sk-..."}
                onChange={(e) => setAiKey(e.currentTarget.value)}
              />
            </label>
            <label>
              段落保真翻译通道
              <select
                value={aiSettings.translationProvider}
                onChange={(e) =>
                  setAiSettings({
                    ...aiSettings,
                    translationProvider: e.currentTarget.value as "byok" | "free",
                  })
                }
              >
                <option value="byok">BYOK / 本地模型</option>
                <option value="free">免 Key 翻译通道</option>
              </select>
            </label>
            <div className="nt-row-actions nt-wide-field">
              <button
                type="button"
                className="nt-btn nt-btn--primary"
                onClick={async () => {
                  const res = await omnimailWorkbenchClient.updateAiSettings({
                    ...aiSettings,
                    ...(aiKey.trim() ? { apiKey: aiKey.trim() } : {}),
                  });
                  setAiSettings(res.settings);
                  setAiKey("");
                  setNotice("已保存本地 AI 与保真翻译配置");
                }}
              >
                保存 AI 配置
              </button>
              <button
                type="button"
                className="nt-btn nt-btn--secondary"
                onClick={async () => {
                  const probe = await omnimailWorkbenchClient.testAiModel();
                  setNotice(`模型连通正常 (${probe.latencyMs}ms): ${probe.sample}`);
                }}
              >
                测试模型连通性
              </button>
            </div>
          </div>
        )}
        {notice && <small>{notice}</small>}
      </section>
    </div>
  );
}

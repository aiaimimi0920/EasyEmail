import { Button, Notice } from '@neuro/ui';
import { useState } from "react";
import { api, errorMessage } from "./api";
import type { NormalAccount } from "./normal-accounts";
import type { MailFourStageProbeReport } from "../../base/src/domain/mail-provider-presets";

export function NormalConnectionDiagnostics({ account, disabled, onAccount }: {
  account: NormalAccount;
  disabled: boolean;
  onAccount(next: NormalAccount): void;
}) {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<MailFourStageProbeReport | null>(null);
  const [error, setError] = useState("");

  async function runDiagnostics() {
    if (running || disabled) return;
    setRunning(true);
    setError("");
    try {
      const res = await api<{ report: MailFourStageProbeReport; account: NormalAccount }>(
        `/normal-accounts/${account.id}/diagnose`,
        "POST",
        { expectedRevision: account.revision },
      );
      setReport(res.report);
      onAccount(res.account);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  return <div className="connection-diagnostics">
    <Button type="button" variant="quiet" disabled={disabled || running} onClick={() => void runDiagnostics()} wrap>
      {running ? "正在执行四步握手诊断…" : "四步连接诊断 (DNS/TLS/IMAP/SMTP)"}
    </Button>
    {error && <Notice role="alert" tone="danger">{error}</Notice>}
    {report && <section aria-label="四阶段连接诊断报告">
      <Notice role={report.ok ? "status" : "alert"} tone={report.ok ? "info" : "danger"}>{report.summary}</Notice>
      <ul>
        {report.steps.map((step) => (
          <li key={step.stage}>
            <strong>{step.ok ? "✓" : "✕"} {step.label}</strong>
            {step.durationMs > 0 ? ` (${step.durationMs} ms)` : ""}：{step.detail}
            {step.suggestion && <div><small>排障建议：{step.suggestion}</small></div>}
          </li>
        ))}
      </ul>
    </section>}
  </div>;
}

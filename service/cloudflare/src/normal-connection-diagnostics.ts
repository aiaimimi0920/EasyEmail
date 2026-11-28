import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { imapEndpoint, normalRevision } from "./normal-account-input";
import { normalAccount, normalContext } from "./normal-account-store";
import { normalAccountView } from "./normal-account-model";
import { normalMailAuthentication } from "./normal-mail-authentication";
import { rateLimit } from "./rate-limits";
import { listImapFolders, testImapConnection } from "./normal-imap-client";
import { smtpConfig, smtpContext } from "./smtp-config-store";
import { smtpEndpoint } from "./smtp-config-input";
import { withMailSocket } from "./mail-socket-session";
import { SmtpWire } from "./smtp-wire";
import { mailSasl } from "./mail-authentication";
import { authenticateSmtp } from "./smtp-auth";
import {
  buildMailProbeAdvice,
  detectMailProviderPreset,
  type MailFourStageProbeReport,
  type MailProbeStageReport,
} from "../../base/src/domain/mail-provider-presets";

async function probeSmtpAuthOnly(
  endpoint: Awaited<ReturnType<typeof smtpEndpoint>>,
  username: string,
  authentication: Parameters<typeof mailSasl>[1],
): Promise<void> {
  const sasl = mailSasl(username, authentication);
  await withMailSocket(endpoint, "smtp", async (socket, control) => {
    const wire = new SmtpWire(socket, control);
    try {
      await socket.opened;
      if ((await wire.reply()).code !== 220) throw new HttpError(502, "smtp_greeting_rejected");
      await wire.write("EHLO easyemail.invalid\r\n");
      let ehlo = await wire.reply();
      if (ehlo.code !== 250) throw new HttpError(502, "smtp_command_rejected");
      let caps = ehlo.lines.slice(1);
      if (wire.needsStartTls) {
        if (!caps.some((line) => /^STARTTLS$/i.test(line))) throw new HttpError(502, "smtp_starttls_unavailable");
        await wire.write("STARTTLS\r\n");
        if ((await wire.reply()).code !== 220) throw new HttpError(502, "smtp_starttls_rejected");
        await wire.startTls();
        await wire.write("EHLO easyemail.invalid\r\n");
        ehlo = await wire.reply();
        if (ehlo.code !== 250) throw new HttpError(502, "smtp_command_rejected");
        caps = ehlo.lines.slice(1);
      }
      await authenticateSmtp(wire, caps, sasl);
      await wire.write("NOOP\r\n");
      await wire.reply();
      await wire.write("QUIT\r\n").catch(() => {});
    } finally {
      wire.release();
    }
  });
}

export async function diagnoseNormalAccount(request: Request, env: Env, identity: Identity, id: string): Promise<Response> {
  const body = await readJson(request);
  const revision = normalRevision(body);
  if (Object.keys(body).some((key) => key !== "expectedRevision")) {
    throw new HttpError(400, "invalid_normal_account_request");
  }
  const row = await normalAccount(env, identity.userId, id);
  if (!row || row.deleted_at !== null) throw new HttpError(404, "not_found");
  if (row.revision !== revision) throw new HttpError(409, "normal_account_changed");
  if (!row.enabled) throw new HttpError(409, "normal_account_disabled");

  const endpoint = await imapEndpoint(env, row.endpoint_id);
  if (endpoint.hash !== row.endpoint_hash) throw new HttpError(409, "imap_endpoint_changed");

  await rateLimit(env, "normal-account-test", identity.userId, 5);
  await rateLimit(env, "normal-account-test-global", "platform", 30);

  const detectedPreset = detectMailProviderPreset(row.email_address);
  const providerId = detectedPreset?.id;
  const steps: MailProbeStageReport[] = [
    { stage: "dns", label: "DNS 解析与收发端口可达", ok: false, durationMs: 0, detail: "" },
    { stage: "tls", label: "TLS 安全握手与通道升级", ok: false, durationMs: 0, detail: "" },
    { stage: "imap", label: "IMAP 认证、安全 ID 与目录读取", ok: false, durationMs: 0, detail: "" },
    { stage: "smtp", label: "SMTP 发件通道认证与心跳", ok: false, durationMs: 0, detail: "" },
  ];

  // Stage 1 + 2: Socket reachability & TLS handshake
  const tConn = Date.now();
  try {
    await withMailSocket(endpoint, "imap", async (socket, control) => {
      await socket.opened;
      control.assertActive();
    });
    const elapsed = Math.max(1, Date.now() - tConn);
    steps[0]!.ok = true;
    steps[0]!.durationMs = elapsed;
    steps[0]!.detail = `收件端点 ${endpoint.hostname}:${endpoint.port} 可达`;
    steps[1]!.ok = true;
    steps[1]!.durationMs = elapsed;
    steps[1]!.detail = endpoint.security === "starttls" ? "端口已连通，将在协议握手阶段执行 STARTTLS 升级" : "TLS 安全加密通道握手通过";
  } catch (err) {
    const code = err instanceof HttpError ? err.code : "imap_connection_failed";
    const elapsed = Math.max(1, Date.now() - tConn);
    const isTlsFailure = /tls|cert/i.test(code);
    if (isTlsFailure) {
      steps[0]!.ok = true;
      steps[0]!.durationMs = elapsed;
      steps[0]!.detail = `端口 ${endpoint.hostname}:${endpoint.port} 已连通`;
      steps[1]!.durationMs = elapsed;
      steps[1]!.detail = `TLS 握手异常 (${code})`;
      steps[1]!.suggestion = buildMailProbeAdvice("tls", providerId);
    } else {
      steps[0]!.durationMs = elapsed;
      steps[0]!.detail = `连接失败 (${code})`;
      steps[0]!.suggestion = buildMailProbeAdvice("dns", providerId);
    }
    const report: MailFourStageProbeReport = {
      ok: false,
      summary: steps[isTlsFailure ? 1 : 0]!.suggestion ?? "连接服务器失败",
      ...(providerId ? { providerId } : {}),
      steps,
    };
    return json({ report, account: normalAccountView(row) });
  }

  // Stage 3: IMAP Authentication + RFC2971 ID + Folder discovery
  const tImap = Date.now();
  let folderCount = 1;
  try {
    const credential = await normalMailAuthentication(env, row, row.credential_cipher, normalContext(id, identity.userId), endpoint, row.username);
    const inboxCheck = await testImapConnection(endpoint, row.username, credential.authentication);
    try {
      const discovered = await listImapFolders(endpoint, row.username, credential.authentication);
      folderCount = discovered.folders.length;
    } catch {
      folderCount = 1;
    }
    steps[2]!.ok = true;
    steps[2]!.durationMs = Math.max(1, Date.now() - tImap);
    steps[2]!.detail = `IMAP 认证成功 · INBOX ${inboxCheck.inbox.messages} 封 · 识别 ${folderCount} 个远端目录`;
  } catch (err) {
    const code = err instanceof HttpError ? err.code : "imap_auth_failed";
    steps[2]!.durationMs = Math.max(1, Date.now() - tImap);
    steps[2]!.detail = `IMAP 认证或只读检查失败 (${code})`;
    steps[2]!.suggestion = buildMailProbeAdvice("imap", providerId);
    const report: MailFourStageProbeReport = {
      ok: false,
      summary: steps[2]!.suggestion,
      ...(providerId ? { providerId } : {}),
      steps,
    };
    return json({ report, account: normalAccountView(row) });
  }

  // Stage 4: Optional SMTP Authentication + NOOP
  const tSmtp = Date.now();
  const smtpRow = await smtpConfig(env, identity.userId, id);
  if (!smtpRow || !smtpRow.enabled || !smtpRow.credential_cipher || smtpRow.account_revision !== row.revision) {
    steps[3]!.ok = true;
    steps[3]!.durationMs = 0;
    steps[3]!.detail = "尚未启用独立 SMTP 发件配置（仅收件模式正常可用）";
  } else {
    try {
      const sEndpoint = await smtpEndpoint(env, smtpRow.endpoint_id);
      const sCred = await normalMailAuthentication(env, row, smtpRow.credential_cipher, smtpContext(id, identity.userId), sEndpoint, smtpRow.username);
      await probeSmtpAuthOnly(sEndpoint, smtpRow.username, sCred.authentication);
      steps[3]!.ok = true;
      steps[3]!.durationMs = Math.max(1, Date.now() - tSmtp);
      steps[3]!.detail = `SMTP (${sEndpoint.hostname}:${sEndpoint.port}) 认证与 NOOP 心跳通过`;
    } catch (err) {
      const code = err instanceof HttpError ? err.code : "smtp_connection_failed";
      steps[3]!.durationMs = Math.max(1, Date.now() - tSmtp);
      steps[3]!.detail = `SMTP 发件认证未通过 (${code})`;
      steps[3]!.suggestion = buildMailProbeAdvice("smtp", providerId);
      const report: MailFourStageProbeReport = {
        ok: false,
        summary: steps[3]!.suggestion,
        ...(providerId ? { providerId } : {}),
        discoveredFolders: folderCount,
        steps,
      };
      return json({ report, account: normalAccountView(row) });
    }
  }

  const report: MailFourStageProbeReport = {
    ok: true,
    summary: "四阶段协议探测全部通过",
    ...(providerId ? { providerId } : {}),
    discoveredFolders: folderCount,
    steps,
  };
  return json({ report, account: normalAccountView(row) });
}

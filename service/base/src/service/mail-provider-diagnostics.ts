import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import type { MailAccount } from "../domain/account.js";
import { EasyEmailError } from "../domain/errors.js";
import {
  buildMailProbeAdvice,
  detectMailProviderPreset,
  listMailProviderPresets,
  type MailFourStageProbeReport,
  type MailMxRecordInput,
  type MailProbeStageReport,
  type MailProviderPreset,
} from "../domain/mail-provider-presets.js";
import type {
  MailCredentialResolver,
  MailImapConnectionTester,
  MailSmtpTransport,
} from "./account-connectivity.js";

export type MxLookupFn = (domain: string) => Promise<MailMxRecordInput[]>;

async function defaultNodeMxLookup(domain: string): Promise<MailMxRecordInput[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("MX lookup timed out")), 2500);
      }),
    ]);
    return records.map((r) => ({ exchange: r.exchange, priority: r.priority }));
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function listLocalMailProviderPresets(): MailProviderPreset[] {
  return listMailProviderPresets(true);
}

export async function detectLocalMailProviderPreset(
  emailOrDomain: string,
  mxLookup: MxLookupFn = defaultNodeMxLookup,
): Promise<{ preset: MailProviderPreset | null; mxExchanges: string[] }> {
  const cleaned = emailOrDomain.trim().toLowerCase();
  if (!cleaned || cleaned.length > 254) {
    throw new EasyEmailError("INVALID_QUERY", "email or domain is required for provider detection.");
  }
  const direct = detectMailProviderPreset(cleaned);
  if (direct) {
    return { preset: direct, mxExchanges: [] };
  }
  const atIdx = cleaned.lastIndexOf("@");
  const domain = (atIdx >= 0 ? cleaned.slice(atIdx + 1) : cleaned).replace(/\.+$/, "");
  if (!domain || !domain.includes(".")) {
    return { preset: null, mxExchanges: [] };
  }
  const mxRecords = await mxLookup(domain);
  const byMx = detectMailProviderPreset(cleaned, mxRecords);
  return {
    preset: byMx ?? null,
    mxExchanges: mxRecords.slice(0, 5).map((r) => r.exchange),
  };
}

async function probeTcpReachability(host: string, port: number, timeoutMs = 6000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("TCP connection timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

async function probeDirectTlsHandshake(host: string, port: number, timeoutMs = 6000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      ...(net.isIP(host) === 0 ? { servername: host } : {}),
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    }, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("TLS handshake timed out"));
    }, timeoutMs);
    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

export interface FourStageProbeDependencies {
  credentialResolver?: MailCredentialResolver;
  imapTester?: MailImapConnectionTester;
  smtpTransport?: MailSmtpTransport;
  tcpProber?: (host: string, port: number) => Promise<void>;
  tlsProber?: (host: string, port: number) => Promise<void>;
}

export async function runMailAccountFourStageProbe(
  account: MailAccount,
  deps: FourStageProbeDependencies,
): Promise<MailFourStageProbeReport> {
  if (!account.imap) {
    throw new EasyEmailError("ACCOUNT_IMAP_CONFIG_REQUIRED", "The account has no IMAP connection profile.");
  }
  const preset = detectMailProviderPreset(account.primaryAddress ?? account.imap.username);
  const providerId = preset?.id;
  const tcpProbe = deps.tcpProber ?? probeTcpReachability;
  const tlsProbe = deps.tlsProber ?? probeDirectTlsHandshake;

  const steps: MailProbeStageReport[] = [
    { stage: "dns", label: "DNS 解析与端口连通", ok: false, durationMs: 0, detail: "" },
    { stage: "tls", label: "TLS 安全握手与证书校验", ok: false, durationMs: 0, detail: "" },
    { stage: "imap", label: "IMAP 收件认证与协议能力", ok: false, durationMs: 0, detail: "" },
    { stage: "smtp", label: "SMTP 发件通道认证校验", ok: false, durationMs: 0, detail: "" },
  ];

  // Step 1: DNS & TCP
  const t0 = Date.now();
  try {
    await tcpProbe(account.imap.host, account.imap.port);
    if (account.smtp) {
      await tcpProbe(account.smtp.host, account.smtp.port);
    }
    steps[0]!.ok = true;
    steps[0]!.durationMs = Math.max(1, Date.now() - t0);
    steps[0]!.detail = account.smtp
      ? `IMAP (${account.imap.host}:${account.imap.port}) 与 SMTP (${account.smtp.host}:${account.smtp.port}) 均可达`
      : `IMAP (${account.imap.host}:${account.imap.port}) 端口可达`;
  } catch {
    steps[0]!.durationMs = Math.max(1, Date.now() - t0);
    steps[0]!.detail = "目标服务器主机解析失败或端口不可达";
    steps[0]!.suggestion = buildMailProbeAdvice("dns", providerId);
    return { ok: false, summary: steps[0]!.suggestion, ...(providerId ? { providerId } : {}), steps };
  }

  // Step 2: TLS Handshake
  const t1 = Date.now();
  if (account.imap.security === "tls") {
    try {
      await tlsProbe(account.imap.host, account.imap.port);
      steps[1]!.ok = true;
      steps[1]!.durationMs = Math.max(1, Date.now() - t1);
      steps[1]!.detail = "TLS 1.2+ 证书链与主机名校验通过";
    } catch {
      steps[1]!.durationMs = Math.max(1, Date.now() - t1);
      steps[1]!.detail = "TLS 握手或证书校验失败";
      steps[1]!.suggestion = buildMailProbeAdvice("tls", providerId);
      return { ok: false, summary: steps[1]!.suggestion, ...(providerId ? { providerId } : {}), steps };
    }
  } else {
    steps[1]!.ok = true;
    steps[1]!.durationMs = 0;
    steps[1]!.detail = "采用 STARTTLS 模式，将在协议握手阶段升级校验";
  }

  // Step 3: IMAP Auth
  const t2 = Date.now();
  const imapRef = account.credentialRefs.find((r) => r.credentialKind === "imap_password" && r.status !== "disabled");
  if (!imapRef || !deps.credentialResolver || !deps.imapTester) {
    steps[2]!.detail = "当前运行时未就绪凭据解析器或 IMAP 测试器";
    steps[2]!.suggestion = buildMailProbeAdvice("imap", providerId);
    return { ok: false, summary: steps[2]!.detail, ...(providerId ? { providerId } : {}), steps };
  }
  try {
    const resolved = await deps.credentialResolver.resolveCredential({ account, credentialRef: imapRef, useCase: "imap-test" });
    if (resolved.status !== "resolved" || !resolved.secret) {
      throw new Error("credential_missing");
    }
    const imapRes = await deps.imapTester.testConnection(account.imap, resolved.secret);
    steps[2]!.ok = true;
    steps[2]!.durationMs = Math.max(1, Date.now() - t2);
    steps[2]!.detail = `IMAP 认证通过 (${imapRes.capabilitySummary.slice(0, 120)})`;
  } catch {
    steps[2]!.durationMs = Math.max(1, Date.now() - t2);
    steps[2]!.detail = "IMAP 登录或授权码校验被服务器拒绝";
    steps[2]!.suggestion = buildMailProbeAdvice("imap", providerId);
    return { ok: false, summary: steps[2]!.suggestion, ...(providerId ? { providerId } : {}), steps };
  }

  // Step 4: SMTP Auth (if configured)
  const t3 = Date.now();
  const smtpRef = account.credentialRefs.find((r) => r.credentialKind === "smtp_password" && r.status !== "disabled");
  if (!account.smtp || !smtpRef || !deps.smtpTransport) {
    steps[3]!.ok = true;
    steps[3]!.durationMs = 0;
    steps[3]!.detail = "未配置独立 SMTP 发件通道（仅收件模式就绪）";
  } else {
    try {
      const resolvedSmtp = await deps.credentialResolver.resolveCredential({ account, credentialRef: smtpRef, useCase: "smtp-test" });
      if (resolvedSmtp.status !== "resolved" || !resolvedSmtp.secret) {
        throw new Error("smtp_credential_missing");
      }
      await deps.smtpTransport.testConnection(account.smtp, resolvedSmtp.secret);
      steps[3]!.ok = true;
      steps[3]!.durationMs = Math.max(1, Date.now() - t3);
      steps[3]!.detail = `SMTP (${account.smtp.host}:${account.smtp.port}) 发件认证通过`;
    } catch {
      steps[3]!.durationMs = Math.max(1, Date.now() - t3);
      steps[3]!.detail = "SMTP 发件认证失败";
      steps[3]!.suggestion = buildMailProbeAdvice("smtp", providerId);
      return { ok: false, summary: steps[3]!.suggestion, ...(providerId ? { providerId } : {}), steps };
    }
  }

  return { ok: true, summary: "四阶段协议探测全部通过", ...(providerId ? { providerId } : {}), steps };
}

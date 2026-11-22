param(
    [switch]$ConfirmExternalSideEffects,
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '../apps/desktop/src-tauri/target/release/easyemailam.exe'),
    [int]$StartupTimeoutSeconds = 70,
    [int]$ActionTimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ConfirmExternalSideEffects) {
    throw 'Refusing to contact an external SMTP server or send external mail without -ConfirmExternalSideEffects.'
}

. (Join-Path $PSScriptRoot '../apps/desktop/scripts/lib/desktop-credential-smoke-support.ps1')

function Redact-SensitiveText {
    param(
        [string]$Text,
        [string[]]$SensitiveSecrets,
        [string[]]$SensitiveEmails
    )
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $output = $Text
    foreach ($secret in $SensitiveSecrets) {
        if (-not [string]::IsNullOrEmpty($secret)) {
            $output = $output.Replace($secret, '[REDACTED_SECRET]')
        }
    }
    foreach ($email in $SensitiveEmails) {
        if (-not [string]::IsNullOrEmpty($email)) {
            $output = $output.Replace($email, '[REDACTED_EMAIL]')
        }
    }
    return $output
}

$smtpEmail = $env:EASYEMAIL_REAL_SMTP_EMAIL
$smtpHost = $env:EASYEMAIL_REAL_SMTP_HOST
$smtpPortRaw = if ($env:EASYEMAIL_REAL_SMTP_PORT) { $env:EASYEMAIL_REAL_SMTP_PORT } else { '465' }
$smtpSecurity = if ($env:EASYEMAIL_REAL_SMTP_SECURITY) { $env:EASYEMAIL_REAL_SMTP_SECURITY.ToLowerInvariant() } else { 'tls' }
$smtpUsername = if ($env:EASYEMAIL_REAL_SMTP_USERNAME) { $env:EASYEMAIL_REAL_SMTP_USERNAME } else { $smtpEmail }
$smtpPassword = $env:EASYEMAIL_REAL_SMTP_PASSWORD
$smtpRecipient = if ($env:EASYEMAIL_REAL_SMTP_RECIPIENT) { $env:EASYEMAIL_REAL_SMTP_RECIPIENT } else { $smtpEmail }

if (
    [string]::IsNullOrWhiteSpace($smtpEmail) -or
    [string]::IsNullOrWhiteSpace($smtpHost) -or
    [string]::IsNullOrWhiteSpace($smtpPassword)
) {
    throw 'Set EASYEMAIL_REAL_SMTP_EMAIL, EASYEMAIL_REAL_SMTP_HOST, and EASYEMAIL_REAL_SMTP_PASSWORD in the environment (never pass secrets on the CLI).'
}
$smtpPort = [int]$smtpPortRaw
if ($smtpPort -lt 1 -or $smtpPort -gt 65535 -or ($smtpSecurity -ne 'tls' -and $smtpSecurity -ne 'starttls')) {
    throw 'EASYEMAIL_REAL_SMTP_PORT must be 1..65535 and EASYEMAIL_REAL_SMTP_SECURITY must be tls or starttls.'
}

$executable = [System.IO.Path]::GetFullPath($ExecutablePath)
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Desktop executable is missing: $executable"
}

$gateRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'easyemail-real-smtp-gate'))
$runRoot = [System.IO.Path]::GetFullPath((Join-Path $gateRoot ([Guid]::NewGuid().ToString('N'))))
$dataDir = Join-Path $runRoot 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

$smtpSecretKey = "ref:v1:desktop/$([Guid]::NewGuid().ToString('N'))"
$imapSecretKey = "ref:v1:desktop/$([Guid]::NewGuid().ToString('N'))"

$previousDataDir = $env:EASYEMAILAM_DATA_DIR
$desktopProcess = $null
$corePid = $null

try {
    Set-EasyEmailSmokeVaultSecret -SecretKey $imapSecretKey -SecretValue $smtpPassword
    Set-EasyEmailSmokeVaultSecret -SecretKey $smtpSecretKey -SecretValue $smtpPassword
    $env:EASYEMAILAM_DATA_DIR = $dataDir

    $portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $portProbe.Start()
    $cdpPort = ([System.Net.IPEndPoint]$portProbe.LocalEndpoint).Port
    $portProbe.Stop()
    $webViewDir = Join-Path $runRoot 'webview2'
    New-Item -ItemType Directory -Path $webViewDir -Force | Out-Null
    $env:WEBVIEW2_USER_DATA_FOLDER = $webViewDir
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$cdpPort"

    $desktopProcess = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden
    $cdpRunner = @'
import { chromium } from "playwright-core";
const [endpoint, timeoutRaw, email, smtpHost, smtpPortRaw, smtpSecurity, smtpUsername, imapSecretKey, smtpSecretKey, recipient] = process.argv.slice(2);
const timeoutMs = Number(timeoutRaw);
const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) break;
  } catch {}
  await new Promise((res) => setTimeout(res, 250));
}
const browser = await chromium.connectOverCDP(endpoint);
try {
  let page;
  while (Date.now() < deadline) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("http://tauri.localhost"));
    if (page) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  if (!page) throw new Error("Packaged WebView did not open.");
  await page.locator('main[data-view="mail"]').waitFor({ state: "visible", timeout: timeoutMs });

  const outcome = await page.evaluate(async (args) => {
    const runtime = await window.__TAURI_INTERNALS__.invoke("desktop_core_runtime");
    const headers = {
      authorization: `Bearer ${runtime.api_token}`,
      "content-type": "application/json",
    };
    const createRes = await fetch(`${runtime.base_url}/mail/accounts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "normal_long_lived",
        displayName: "Real SMTP Gate Account",
        primaryAddress: args.email,
        imap: { host: args.smtpHost, port: 993, security: "tls", username: args.smtpUsername },
        smtp: {
          host: args.smtpHost,
          port: Number(args.smtpPortRaw),
          security: args.smtpSecurity,
          username: args.smtpUsername,
        },
        credentialRefs: [
          {
            secretBackend: "windows_credential_manager",
            secretKey: args.imapSecretKey,
            credentialKind: "imap_password",
            authMethod: "password",
          },
          {
            secretBackend: "windows_credential_manager",
            secretKey: args.smtpSecretKey,
            credentialKind: "smtp_password",
            authMethod: "password",
          },
        ],
      }),
    });
    if (!createRes.ok) throw new Error(`Account create HTTP ${createRes.status}`);
    const { account } = await createRes.json();
    const smtpRef = account.credentialRefs.find((ref) => ref.credentialKind === "smtp_password");
    const testRes = await fetch(`${runtime.base_url}/mail/accounts/smtp/test`, {
      method: "POST",
      headers,
      body: JSON.stringify({ accountId: account.id, credentialRefId: smtpRef.id }),
    });
    if (!testRes.ok) throw new Error(`Real SMTP test HTTP ${testRes.status}`);
    const testBody = await testRes.json();

    const enqueueRes = await fetch(`${runtime.base_url}/mail/send-queue`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": `real-smtp-gate-${Date.now()}` },
      body: JSON.stringify({
        accountId: account.id,
        targetAddress: args.recipient,
        subject: "[EasyEmail Real SMTP Gate] Delivery Check",
        bodyText: "Opt-in EasyEmail M5 real SMTP verification message.",
      }),
    });
    if (!enqueueRes.ok) throw new Error(`Enqueue HTTP ${enqueueRes.status}`);
    const enqueued = await enqueueRes.json();

    const runRes = await fetch(`${runtime.base_url}/mail/send-queue/${encodeURIComponent(enqueued.queueItem.id)}/run`, {
      method: "POST",
      headers,
    });
    if (!runRes.ok) throw new Error(`Run item HTTP ${runRes.status}`);
    const ran = await runRes.json();
    return {
      authenticated: testBody?.result?.authenticated === true,
      queueStatus: ran?.queueItem?.status,
    };
  }, { email, smtpHost, smtpPortRaw, smtpSecurity, smtpUsername, imapSecretKey, smtpSecretKey, recipient });

  if (!outcome.authenticated || outcome.queueStatus !== "sent") {
    throw new Error(`Real SMTP gate finished with status ${outcome.queueStatus}.`);
  }
} finally {
  await browser.close();
}
'@
    $cdpRunnerPath = Join-Path $runRoot 'real-smtp-cdp.mjs'
    [System.IO.File]::WriteAllText($cdpRunnerPath, $cdpRunner, [System.Text.UTF8Encoding]::new($false))
    Push-Location (Join-Path $PSScriptRoot '../apps/desktop')
    try {
        & node $cdpRunnerPath "http://127.0.0.1:$cdpPort" ($ActionTimeoutSeconds * 1000) `
            $smtpEmail $smtpHost "$smtpPort" $smtpSecurity $smtpUsername $imapSecretKey $smtpSecretKey $smtpRecipient
        if ($LASTEXITCODE -ne 0) {
            throw 'Real SMTP CDP connection and delivery test failed.'
        }
    } finally {
        Pop-Location
    }

    $null = Request-EasyEmailDesktopClose -Process $desktopProcess
    $null = $desktopProcess.WaitForExit(10000)
    $desktopProcess = $null
    $corePid = $null

    Assert-ZeroCanarySecretMatches -RootDirectory $dataDir -CanarySecrets @($smtpPassword)
    Write-Output 'REAL_SMTP_AUTHENTICATED=True'
    Write-Output 'REAL_SMTP_SENT=True'
    Write-Output 'REAL_SMTP_CANARY_ZERO_MATCHES=True'
} catch {
    $safeMessage = Redact-SensitiveText -Text $_.Exception.Message `
        -SensitiveSecrets @($smtpPassword) -SensitiveEmails @($smtpEmail, $smtpUsername, $smtpRecipient)
    throw $safeMessage
} finally {
    if ($desktopProcess -and -not $desktopProcess.HasExited) {
        Stop-Process -Id $desktopProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($corePid) {
        Stop-Process -Id $corePid -Force -ErrorAction SilentlyContinue
    }
    try { Remove-EasyEmailSmokeVaultSecret -SecretKey $imapSecretKey } catch {}
    try { Remove-EasyEmailSmokeVaultSecret -SecretKey $smtpSecretKey } catch {}
    if ($null -eq $previousDataDir) {
        Remove-Item Env:EASYEMAILAM_DATA_DIR -ErrorAction SilentlyContinue
    } else {
        $env:EASYEMAILAM_DATA_DIR = $previousDataDir
    }
    if (Test-Path -LiteralPath $runRoot) {
        $resolvedRunRoot = [System.IO.Path]::GetFullPath($runRoot)
        if ($resolvedRunRoot.StartsWith($gateRoot + [System.IO.Path]::DirectorySeparatorChar)) {
            Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

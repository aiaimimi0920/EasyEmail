param(
    [switch]$ConfirmExternalSideEffects,
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '../apps/desktop/src-tauri/target/release/easyemailam.exe'),
    [int]$StartupTimeoutSeconds = 70,
    [int]$ActionTimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ConfirmExternalSideEffects) {
    throw 'Refusing to contact an external IMAP server without -ConfirmExternalSideEffects.'
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

$imapEmail = $env:EASYEMAIL_REAL_IMAP_EMAIL
$imapHost = $env:EASYEMAIL_REAL_IMAP_HOST
$imapPortRaw = if ($env:EASYEMAIL_REAL_IMAP_PORT) { $env:EASYEMAIL_REAL_IMAP_PORT } else { '993' }
$imapSecurity = if ($env:EASYEMAIL_REAL_IMAP_SECURITY) { $env:EASYEMAIL_REAL_IMAP_SECURITY.ToLowerInvariant() } else { 'tls' }
$imapUsername = if ($env:EASYEMAIL_REAL_IMAP_USERNAME) { $env:EASYEMAIL_REAL_IMAP_USERNAME } else { $imapEmail }
$imapPassword = $env:EASYEMAIL_REAL_IMAP_PASSWORD

if (
    [string]::IsNullOrWhiteSpace($imapEmail) -or
    [string]::IsNullOrWhiteSpace($imapHost) -or
    [string]::IsNullOrWhiteSpace($imapPassword)
) {
    throw 'Set EASYEMAIL_REAL_IMAP_EMAIL, EASYEMAIL_REAL_IMAP_HOST, and EASYEMAIL_REAL_IMAP_PASSWORD in the environment (never pass secrets on the CLI).'
}
$imapPort = [int]$imapPortRaw
if ($imapPort -lt 1 -or $imapPort -gt 65535 -or ($imapSecurity -ne 'tls' -and $imapSecurity -ne 'starttls')) {
    throw 'EASYEMAIL_REAL_IMAP_PORT must be 1..65535 and EASYEMAIL_REAL_IMAP_SECURITY must be tls or starttls.'
}

$executable = [System.IO.Path]::GetFullPath($ExecutablePath)
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Desktop executable is missing: $executable"
}

$gateRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'easyemail-real-imap-gate'))
$runRoot = [System.IO.Path]::GetFullPath((Join-Path $gateRoot ([Guid]::NewGuid().ToString('N'))))
$dataDir = Join-Path $runRoot 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

$accountId = "acct_smoke_$([Guid]::NewGuid().ToString('N'))"
$secretKey = "secret://imap/$accountId"
$legacySeedScript = Join-Path $PSScriptRoot '../apps/desktop/scripts/seed-and-import-legacy-accounts.mjs'
$missingAccountId = "acct_smoke_$([Guid]::NewGuid().ToString('N'))"
$missingSecretKey = "secret://imap/$missingAccountId"

$previousDataDir = $env:EASYEMAILAM_DATA_DIR
$desktopProcess = $null
$corePid = $null

try {
    Set-EasyEmailSmokeVaultSecret -SecretKey $secretKey -SecretValue $imapPassword
    $env:EASYEMAILAM_DATA_DIR = $dataDir

    # Run 1: initialize isolated desktop runtime and SQLite files, then close cleanly.
    $desktopProcess = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 250
        $desktopProcess.Refresh()
        if ($desktopProcess.HasExited) {
            throw "Desktop exited during startup with code $($desktopProcess.ExitCode)."
        }
        $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($desktopProcess.Id)" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ieq 'node.exe' } |
            Select-Object -First 1
        if ($child) {
            $corePid = [int]$child.ProcessId
            $listener = Get-NetTCPConnection -OwningProcess $corePid -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
                Select-Object -First 1
            if ($listener) { break }
        }
    } while ((Get-Date) -lt $deadline)
    if (-not $corePid) {
        throw 'Desktop did not start its bundled core.'
    }
    if (-not (Request-EasyEmailDesktopClose -Process $desktopProcess)) {
        throw 'Desktop Run 1 did not accept close request.'
    }
    if (-not $desktopProcess.WaitForExit(10000)) {
        throw 'Desktop Run 1 did not close cleanly.'
    }
    $desktopProcess = $null
    $corePid = $null

    # Seed real IMAP host into relational DB via legacy importer and test against live server across restart via CDP.
    $relationalDbPath = Join-Path $dataDir 'core/state/state/easy-email-relational.sqlite3'
    & node $legacySeedScript `
        --data-dir $dataDir `
        --imap-port $imapPort `
        --imap-username $imapUsername `
        --present-account-id $accountId `
        --present-secret-key $secretKey `
        --missing-account-id $missingAccountId `
        --missing-secret-key $missingSecretKey | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to prepare isolated relational account for real IMAP gate.'
    }
    & node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.prepare('UPDATE mail_accounts SET imap_host=?, imap_security=? WHERE id=?').run(process.argv[2],process.argv[3],process.argv[4]);db.close();" `
        $relationalDbPath $imapHost $imapSecurity $accountId
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to set real IMAP host profile.'
    }

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
const endpoint = process.argv[2];
const timeoutMs = Number(process.argv[3]);
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
  await page.locator('button[data-view="setup"]').click();
  const row = page.locator("article.nt-resource-row").filter({ hasText: "Legacy Imported IMAP" });
  await row.waitFor({ state: "visible", timeout: timeoutMs });
  const testResPromise = page.waitForResponse(
    (res) => new URL(res.url()).pathname === "/mail/accounts/imap/test" && res.request().method() === "POST",
    { timeout: timeoutMs },
  );
  await row.getByRole("button", { name: "Test IMAP" }).click();
  const testRes = await testResPromise;
  if (testRes.status() !== 200) throw new Error(`Real IMAP test returned HTTP ${testRes.status()}.`);
  const authHeader = testRes.request().headers()["authorization"] ?? "";
  const coreOrigin = new URL(testRes.url()).origin;
  const body = await testRes.json();
  if (body?.result?.authenticated !== true) throw new Error("Real IMAP server did not authenticate.");

  const syncResPromise = page.waitForResponse(
    (res) => /^\/mail\/accounts\/[^/]+\/sync$/.test(new URL(res.url()).pathname) && res.request().method() === "POST",
    { timeout: timeoutMs },
  );
  await row.getByRole("button", { name: "Sync" }).click();
  const syncRes = await syncResPromise;
  if (syncRes.status() !== 200) throw new Error(`Real IMAP sync returned HTTP ${syncRes.status()}.`);
  const syncBody = await syncRes.json();
  const syncedAccountId = syncBody?.sync?.accountId;
  if (!syncedAccountId || syncBody?.status?.syncState !== "synced") {
    throw new Error("Real IMAP sync did not transition account to synced.");
  }

  const cdpHeaders = { authorization: authHeader, "content-type": "application/json" };
  const foldersRes = await fetch(`${coreOrigin}/mail/accounts/${encodeURIComponent(syncedAccountId)}/folders`, {
    headers: cdpHeaders,
  });
  if (!foldersRes.ok) throw new Error(`Real IMAP folder list failed with HTTP ${foldersRes.status}.`);
  const foldersBody = await foldersRes.json();
  if (!Array.isArray(foldersBody?.folders) || foldersBody.folders.length === 0) {
    throw new Error("Real IMAP folder discovery returned zero folders.");
  }

  const messagesRes = await fetch(
    `${coreOrigin}/mail/messages?accountId=${encodeURIComponent(syncedAccountId)}&limit=5`,
    { headers: cdpHeaders },
  );
  if (!messagesRes.ok) throw new Error(`Real IMAP message list failed with HTTP ${messagesRes.status}.`);
  const messagesBody = await messagesRes.json();
  const firstMsg = Array.isArray(messagesBody?.messages) ? messagesBody.messages[0] : undefined;
  if (firstMsg?.id) {
    const detailRes = await fetch(`${coreOrigin}/mail/messages/${encodeURIComponent(firstMsg.id)}`, {
      headers: cdpHeaders,
    });
    if (!detailRes.ok) throw new Error(`Real IMAP body hydration failed with HTTP ${detailRes.status}.`);
    const detailBody = await detailRes.json();
    const initialStarred = Boolean(detailBody?.message?.isStarred);

    const toggleRes = await fetch(`${coreOrigin}/mail/messages/${encodeURIComponent(firstMsg.id)}/flags`, {
      method: "PATCH",
      headers: cdpHeaders,
      body: JSON.stringify({ flagName: "starred", enabled: !initialStarred }),
    });
    if (!toggleRes.ok) throw new Error(`Real IMAP reversible flag set failed with HTTP ${toggleRes.status}.`);
    const toggleBody = await toggleRes.json();
    if (toggleBody?.action?.remoteApplied !== true) {
      throw new Error("Real IMAP flag toggle was not applied remotely.");
    }

    const rollbackRes = await fetch(`${coreOrigin}/mail/messages/${encodeURIComponent(firstMsg.id)}/flags`, {
      method: "PATCH",
      headers: cdpHeaders,
      body: JSON.stringify({ flagName: "starred", enabled: initialStarred }),
    });
    if (!rollbackRes.ok) throw new Error(`Real IMAP reversible flag rollback failed with HTTP ${rollbackRes.status}.`);
    const rollbackBody = await rollbackRes.json();
    if (rollbackBody?.action?.remoteApplied !== true) {
      throw new Error("Real IMAP flag rollback was not applied remotely.");
    }
  }
} finally {
  await browser.close();
}
'@
    $cdpRunnerPath = Join-Path $runRoot 'real-imap-cdp.mjs'
    [System.IO.File]::WriteAllText($cdpRunnerPath, $cdpRunner, [System.Text.UTF8Encoding]::new($false))
    Push-Location (Join-Path $PSScriptRoot '../apps/desktop')
    try {
        & node $cdpRunnerPath "http://127.0.0.1:$cdpPort" ($ActionTimeoutSeconds * 1000)
        if ($LASTEXITCODE -ne 0) {
            throw 'Real IMAP CDP connection test failed.'
        }
    } finally {
        Pop-Location
    }

    $null = Request-EasyEmailDesktopClose -Process $desktopProcess
    $null = $desktopProcess.WaitForExit(10000)
    $desktopProcess = $null
    $corePid = $null

    Assert-ZeroCanarySecretMatches -RootDirectory $dataDir -CanarySecrets @($imapPassword)
    Write-Output 'REAL_IMAP_AUTHENTICATED=True'
    Write-Output 'REAL_IMAP_FOLDERS_AND_SYNC_VERIFIED=True'
    Write-Output 'REAL_IMAP_REVERSIBLE_ACTION_VERIFIED=True'
    Write-Output 'REAL_IMAP_CANARY_ZERO_MATCHES=True'
} catch {
    $safeMessage = Redact-SensitiveText -Text $_.Exception.Message `
        -SensitiveSecrets @($imapPassword) -SensitiveEmails @($imapEmail, $imapUsername)
    throw $safeMessage
} finally {
    if ($desktopProcess -and -not $desktopProcess.HasExited) {
        Stop-Process -Id $desktopProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($corePid) {
        Stop-Process -Id $corePid -Force -ErrorAction SilentlyContinue
    }
    try { Remove-EasyEmailSmokeVaultSecret -SecretKey $secretKey } catch {}
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

Set-StrictMode -Version Latest

if (-not ('EasyEmailDesktopSmokeWinCred' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class EasyEmailDesktopSmokeWinCred {
    private const uint CRED_TYPE_GENERIC = 1;
    private const uint CRED_PERSIST_LOCAL_MACHINE = 2;
    private const int ERROR_NOT_FOUND = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
    private static extern void CredFree([In] IntPtr buffer);

    public static void SaveSecret(string targetName, string secretValue) {
        byte[] bytes = Encoding.UTF8.GetBytes(secretValue);
        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            CREDENTIAL cred = new CREDENTIAL();
            cred.Type = CRED_TYPE_GENERIC;
            cred.TargetName = targetName;
            cred.CredentialBlobSize = (uint)bytes.Length;
            cred.CredentialBlob = blob;
            cred.Persist = CRED_PERSIST_LOCAL_MACHINE;
            cred.UserName = "EasyEmailAM";
            if (!CredWrite(ref cred, 0)) {
                throw new InvalidOperationException("CredWriteW failed with Win32 error " + Marshal.GetLastWin32Error());
            }
        } finally {
            for (int i = 0; i < bytes.Length; i++) bytes[i] = 0;
            Marshal.FreeHGlobal(blob);
        }
    }

    public static bool Exists(string targetName) {
        IntPtr ptr;
        if (!CredRead(targetName, CRED_TYPE_GENERIC, 0, out ptr)) {
            int err = Marshal.GetLastWin32Error();
            if (err == ERROR_NOT_FOUND) return false;
            throw new InvalidOperationException("CredReadW failed with Win32 error " + err);
        }
        CredFree(ptr);
        return true;
    }

    public static void DeleteSecret(string targetName) {
        if (!CredDelete(targetName, CRED_TYPE_GENERIC, 0)) {
            int err = Marshal.GetLastWin32Error();
            if (err == ERROR_NOT_FOUND) return;
            throw new InvalidOperationException("CredDeleteW failed with Win32 error " + err);
        }
    }
}
'@
}

function Assert-IsolatedSmokeSecretKey {
    param([Parameter(Mandatory = $true)][string]$SecretKey)
    if ($SecretKey -notmatch '^(ref:v1:desktop/[0-9a-f]{32}|secret://(?:imap|smtp)/acct_smoke_[0-9a-f]{32})$') {
        throw "Refusing to touch non-isolated credential key: $SecretKey"
    }
}

function Set-EasyEmailSmokeVaultSecret {
    param(
        [Parameter(Mandatory = $true)][string]$SecretKey,
        [Parameter(Mandatory = $true)][string]$SecretValue
    )
    Assert-IsolatedSmokeSecretKey -SecretKey $SecretKey
    [EasyEmailDesktopSmokeWinCred]::SaveSecret("EasyEmailAM:$SecretKey", $SecretValue)
}

function Test-EasyEmailSmokeVaultSecret {
    param([Parameter(Mandatory = $true)][string]$SecretKey)
    Assert-IsolatedSmokeSecretKey -SecretKey $SecretKey
    return [EasyEmailDesktopSmokeWinCred]::Exists("EasyEmailAM:$SecretKey")
}

function Remove-EasyEmailSmokeVaultSecret {
    param([Parameter(Mandatory = $true)][string]$SecretKey)
    Assert-IsolatedSmokeSecretKey -SecretKey $SecretKey
    [EasyEmailDesktopSmokeWinCred]::DeleteSecret("EasyEmailAM:$SecretKey")
}

if (-not ('EasyEmailDesktopSmokeWin32Window' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class EasyEmailDesktopSmokeWin32Window {
    private const uint WM_CLOSE = 0x0010;
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    public static bool RequestCloseProcessWindows(int targetPid) {
        bool postedTitled = false;
        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == (uint)targetPid && GetWindowTextLengthW(hWnd) > 0) {
                if (PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) {
                    postedTitled = true;
                }
            }
            return true;
        }, IntPtr.Zero);
        if (postedTitled) {
            return true;
        }
        bool postedVisible = false;
        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == (uint)targetPid && IsWindowVisible(hWnd)) {
                if (PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) {
                    postedVisible = true;
                }
            }
            return true;
        }, IntPtr.Zero);
        return postedVisible;
    }
}
'@
}

function Request-EasyEmailDesktopClose {
    param([Parameter(Mandatory = $true)][Diagnostics.Process]$Process)
    $Process.Refresh()
    if ([EasyEmailDesktopSmokeWin32Window]::RequestCloseProcessWindows($Process.Id)) {
        return $true
    }
    return $Process.CloseMainWindow()
}

function New-EphemeralLoopbackTlsCertificate {
    param(
        [Parameter(Mandatory = $true)][string]$OutputDirectory,
        [Parameter(Mandatory = $true)][string]$GeneratorScriptPath
    )

    $rawJson = (& node $GeneratorScriptPath --out-dir $OutputDirectory)
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to generate ephemeral loopback TLS certificate (exit $LASTEXITCODE)."
    }
    $parsed = $rawJson | ConvertFrom-Json
    return [PSCustomObject]@{
        CertPath = [string]$parsed.certPath
        KeyPath = [string]$parsed.keyPath
    }
}

function Test-BytePatternContains {
    param([byte[]]$Haystack, [byte[]]$Needle)
    if (-not $Haystack -or -not $Needle -or $Needle.Length -eq 0 -or $Haystack.Length -lt $Needle.Length) {
        return $false
    }
    $limit = $Haystack.Length - $Needle.Length
    for ($i = 0; $i -le $limit; $i++) {
        if ($Haystack[$i] -ne $Needle[0]) { continue }
        $matched = $true
        for ($j = 1; $j -lt $Needle.Length; $j++) {
            if ($Haystack[$i + $j] -ne $Needle[$j]) {
                $matched = $false
                break
            }
        }
        if ($matched) { return $true }
    }
    return $false
}

function Assert-ZeroCanarySecretMatches {
    param(
        [Parameter(Mandatory = $true)][string]$RootDirectory,
        [Parameter(Mandatory = $true)][string[]]$CanarySecrets
    )
    $patterns = @()
    foreach ($secret in $CanarySecrets) {
        if ([string]::IsNullOrEmpty($secret)) { continue }
        $patterns += ,([System.Text.Encoding]::UTF8.GetBytes($secret))
        $patterns += ,([System.Text.Encoding]::Unicode.GetBytes($secret))
    }
    $files = Get-ChildItem -LiteralPath $RootDirectory -Recurse -File -Force -ErrorAction SilentlyContinue
    foreach ($file in $files) {
        $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
        foreach ($pattern in $patterns) {
            if (Test-BytePatternContains -Haystack $bytes -Needle $pattern) {
                throw "Canary secret leaked into file: $($file.FullName)"
            }
        }
    }
}

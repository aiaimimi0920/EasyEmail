# Build Userscript

Use `scripts/compile-userscript.ps1` to generate a local userscript with secrets
injected from `config.yaml`.

## What It Does

- reads `config.yaml`
- loads `userscript.secrets`
- replaces the local secret placeholders in the tracked template script
- writes `runtimes/userscript/easy_email_proxy.local.user.js`
- optionally copies the generated script to the clipboard

## Usage

```powershell
pwsh .\scripts\compile-userscript.ps1
```

To force clipboard output:

```powershell
pwsh .\scripts\compile-userscript.ps1 -CopyToClipboard
```

## Notes

- the generated local userscript is ignored by Git
- the tracked template remains secret-free
- keep `config.yaml` local


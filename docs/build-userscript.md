# Build Userscript

Use `scripts/compile-userscript.ps1` to generate a local userscript with secrets
injected from the root `config.yaml`.

## What It Does

- reads the root `config.yaml`
- loads the `userscript.secrets` section from the root `config.yaml`
- replaces the tracked template placeholders with those root-config values
- writes `runtimes/userscript/easy_email_proxy.local.user.js`
- optionally copies the generated script to the clipboard

## Usage

```powershell
pwsh .\scripts\compile-userscript.ps1
```

Validate the tracked template and a generated local build without touching your
working userscript file:

```powershell
pwsh .\scripts\validate-userscript.ps1
```

To force clipboard output:

```powershell
pwsh .\scripts\compile-userscript.ps1 -CopyToClipboard
```

## Notes

- the generated local userscript is ignored by Git
- the tracked template remains secret-free
- keep the root `config.yaml` local, because it is the single source of
  operator secrets for this build
- validation uses `config.example.yaml` and writes to `.tmp/` by default

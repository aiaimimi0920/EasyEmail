# Build Userscript

Use `scripts/compile-userscript.ps1` to assemble the modular template and
generate a local userscript with secrets injected from the root `config.yaml`.
The tracked `easy_email_proxy.user.js` path is a build entry for configuration
compatibility; it is not installed directly.

## What It Does

- reads the root `config.yaml`
- loads the `userscript.secrets` section from the root `config.yaml`
- deterministically assembles `runtimes/userscript/userscript-template.json`
  and its ordered `src/` modules
- replaces the assembled template placeholders with those root-config values
- writes `runtimes/userscript/easy_email_proxy.local.user.js`
- optionally copies the generated script to the clipboard

## Usage

```powershell
pwsh .\scripts\compile-userscript.ps1
```

Validate the assembled template and a generated local build without touching
your working userscript file:

```powershell
pwsh .\scripts\validate-userscript.ps1
```

To force clipboard output:

```powershell
pwsh .\scripts\compile-userscript.ps1 -CopyToClipboard
```

## Notes

- the generated local userscript is ignored by Git
- the tracked source modules and assembled template remain secret-free
- keep the root `config.yaml` local, because it is the single source of
  operator secrets for this build
- validation uses `config.example.yaml` and writes to `.tmp/` by default

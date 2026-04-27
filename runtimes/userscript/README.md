# EasyEmail / runtimes/userscript

`runtimes/userscript` contains the browser-side EasyEmail runtime delivered as a
userscript.

This runtime is intentionally independent. It is not a thin bridge that
requires `service/base` to be online.

## Main Files

- `easy_email_proxy.user.js`: the tracked template userscript
- `generate_local_userscript.ps1`: legacy local wrapper, now routed through
  `scripts/compile-userscript.ps1`
- `easy_email_proxy.local.user.js`: generated local output, ignored by Git

## Local Development Flow

1. Edit the repository root `config.yaml`.
2. Generate the local userscript:

```powershell
pwsh .\scripts\compile-userscript.ps1
```

3. If you want the generated script in the clipboard directly:

```powershell
pwsh .\scripts\compile-userscript.ps1 -CopyToClipboard
```

## Remote Import-Code Flow

The tracked userscript template now also supports a remote import-code
bootstrap path.

That path is designed for trusted machines that should receive provider
configuration from the same private R2 distribution manifest used by
`service/base`.

Supported behaviors:

- first install without local provider secrets
- paste one EasyEmail import code once
- import remote provider settings into `GM_setValue`
- optional auto-sync every two hours
- replace the import code later
- clear the import-code binding without clearing the currently stored settings

Runtime entry points:

- URL parameter: `?easyemail_import_code=<easyemail-import-v1...>`
- menu command: `EasyEmail Runtime: 导入/替换导入码`
- menu command: `EasyEmail Runtime: 立即同步导入配置`
- menu command: `EasyEmail Runtime: 开启/关闭导入配置自动同步`
- menu command: `EasyEmail Runtime: 清除导入码绑定`

## Security Rules

- never commit `easy_email_proxy.local.user.js`
- keep the root `config.yaml` as the single source of operator secrets
- keep the tracked template free of live secrets

## Runtime Positioning

This module is:

- a browser-internal EasyEmail runtime
- a mailbox and OTP helper with provider runtime logic in the browser

This module is not:

- a required frontend for `service/base`
- a bridge that must proxy every action through the local EasyEmail HTTP API

## Provider Scope

The template userscript currently carries a provider set aligned with the main
EasyEmail ecosystem, including:

- `cloudflare_temp_email`
- `mailtm`
- `duckmail`
- `guerrillamail`
- `tempmail-lol`
- `etempmail`
- `tmailor`
- `moemail`
- `m2u`
- `gptmail`
- `im215`

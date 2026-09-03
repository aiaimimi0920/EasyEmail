# EasyEmail / runtimes/userscript

`runtimes/userscript` contains the browser-side EasyEmail runtime delivered as a
userscript.

This runtime is intentionally independent. It is not a thin bridge that
requires `service/base` to be online.

It carries its own browser-side provider implementation and directly requests
the configured upstream provider endpoints. It does not call the
`service/base` HTTP API and does not share the server's provider adapters,
mailbox orchestration, persistence, or message-processing implementation.

## Main Files

- `easy_email_proxy.user.js`: the compatibility entry used by existing config
- `userscript-template.json`: the deterministic source-order manifest
- `src/`: the reviewed runtime metadata and responsibility-based source modules
- `generate_local_userscript.ps1`: legacy local wrapper, now routed through
  `scripts/compile-userscript.ps1`
- `easy_email_proxy.local.user.js`: generated local output, ignored by Git

The local and release builders assemble the entry manifest into one standalone
Userscript before injecting local settings or rewriting release metadata. The
published `.user.js` remains a single IIFE and does not load repository modules
at browser runtime.

`easy_email_proxy.user.js` is a build entry, not an installable raw Userscript.
Install the `.user.js` asset from a public release, or generate the configured
local file with `scripts/compile-userscript.ps1`. Installing the raw build entry
would provide no runtime code.

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

The assembled userscript template also supports a remote import-code bootstrap
path.

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
- keep the tracked source modules and assembled template free of live secrets

## Runtime Positioning

This module is:

- a browser-internal EasyEmail runtime
- a mailbox and OTP helper with provider runtime logic in the browser

This module is not:

- a required frontend for `service/base`
- a bridge that must proxy every action through the local EasyEmail HTTP API
- the provider implementation used by the bundled UI

The Userscript and `service/base` may align on provider names and externally
defined upstream endpoints or ports only. Similar product capabilities do not
make one runtime an implementation dependency of the other.

## Provider Scope

The assembled userscript currently carries a provider set aligned with the main
EasyEmail ecosystem, including:

- `cloudflare_temp_email`
- `mailtm`
- `duckmail`
- `guerrillamail`
- `tempmail-lol`
- `etempmail`
- `moemail`
- `m2u`
- `gptmail`
- `im215`

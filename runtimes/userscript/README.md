# EasyEmail / runtimes/userscript

`runtimes/userscript` contains the browser-side EasyEmail runtime delivered as a
userscript.

This runtime is intentionally independent. It is not a thin bridge that
requires `service/base` to be online.

## Main Files

- `easy_email_proxy.user.js`: the tracked template userscript
- `easy_email_proxy.secrets.example.json`: local secrets example file
- `generate_local_userscript.ps1`: local userscript generator
- `easy_email_proxy.local.user.js`: generated local output, ignored by Git

## Local Development Flow

1. Copy:

   - `easy_email_proxy.secrets.example.json`

   to:

   - `easy_email_proxy.secrets.local.json`

2. Fill in your private local values.

3. Generate the local userscript:

```powershell
powershell -ExecutionPolicy Bypass -File ".\runtimes\userscript\generate_local_userscript.ps1"
```

4. If you want the generated script in the clipboard directly:

```powershell
powershell -ExecutionPolicy Bypass -File ".\runtimes\userscript\generate_local_userscript.ps1" -CopyToClipboard
```

## Security Rules

- never commit `easy_email_proxy.secrets.local.json`
- never commit `easy_email_proxy.local.user.js`
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

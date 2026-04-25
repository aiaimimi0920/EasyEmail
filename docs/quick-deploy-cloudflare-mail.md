# Quick Deploy Cloudflare Mail

Use `scripts/quick-deploy-cloudflare-mail.ps1` to perform the quick cloudflare
mail deployment flow.

## What It Does

- reads `config.yaml`
- optionally installs dependencies
- builds the Cloudflare frontend
- deploys the worker
- optionally syncs Email Routing state and DNS if routing secrets are present

## Usage

```powershell
pwsh .\scripts\quick-deploy-cloudflare-mail.ps1
```

To force the routing sync mode:

```powershell
pwsh .\scripts\quick-deploy-cloudflare-mail.ps1 -SyncMode wildcard
```

To skip dependency installation:

```powershell
pwsh .\scripts\quick-deploy-cloudflare-mail.ps1 -NoInstall
```

To run a safe dry run without publishing to Cloudflare:

```powershell
pwsh .\scripts\quick-deploy-cloudflare-mail.ps1 -DryRun
```

## Notes

- `cloudflareMail.routing` values are read from `config.yaml`
- the quick deploy script uses temporary secret files for the Cloudflare helper
  scripts and cleans them up after use
- keep `config.yaml` local and untracked

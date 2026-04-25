# Contributing

All external contributions go to this repository.

Do not look for a second repository for `cloudflare_temp_email` or a separate
repository for the browser runtime. The public contribution path is always this
monorepo.

## Where To Change Code

- `service/base`: local EasyEmail service runtime
- `runtimes/userscript`: browser-side userscript runtime
- `upstreams/cloudflare_temp_email`: upstream-tracked Cloudflare temp mail code
- `deploy`: deployment templates and helper scripts
- `docs`: repository-level documentation

## Pull Request Expectations

1. Keep changes scoped to the module you are working on.
2. Update documentation when behavior or setup changes.
3. Never commit secrets, generated local userscripts, runtime state, or private
   deployment files.
4. If you change `upstreams/cloudflare_temp_email`, explain whether the change is:
   - an upstream sync import
   - a local patch carried on top of upstream
   - a documentation-only adjustment

## Validation

For `service/base`:

```powershell
Set-Location service/base
npm run typecheck
npm run test
npm run build
```

For `upstreams/cloudflare_temp_email/worker`:

```powershell
Set-Location upstreams/cloudflare_temp_email/worker
corepack pnpm lint
corepack pnpm build
```

For `runtimes/userscript`:

- verify the template script still loads
- verify the local generation script still works with a private secrets file

## Commit Style

Small, focused pull requests are preferred. If a change spans multiple modules,
call that out explicitly in the PR summary.


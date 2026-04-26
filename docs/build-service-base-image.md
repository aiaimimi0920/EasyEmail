# Build EasyEmail Service Base Image

Use `scripts/compile-service-base-image.ps1` to build the Docker image for the
local EasyEmail service runtime.

## What It Does

- reads `config.yaml`
- uses the configured image name and Dockerfile path
- builds only the `service/base` runtime image
- does not package the browser userscript or cloudflare upstream modules into
  the image contents

## Usage

```powershell
pwsh .\scripts\compile-service-base-image.ps1
```

Optional push:

```powershell
pwsh .\scripts\compile-service-base-image.ps1 -Push
```

For GHCR release publishing, prefer:

```powershell
pwsh .\deploy\service\base\publish-ghcr-easy-email-service.ps1 -Push
```

If you want the GHCR publish and Cloudflare mail deployment in one root command,
use:

```powershell
pwsh .\scripts\deploy-easyemail-release.ps1
```

That root release command also runs a post-publish `service/base` smoke check by
default.

For GitHub-hosted publishing without relying on a local Docker daemon, use the
GitHub Actions workflow:

- tag push triggers `.github/workflows/publish-service-base-ghcr.yml`
- manual publish is available through `workflow_dispatch`

## Notes

- the Docker build context is still the repository root, but the Dockerfile only
  copies the service runtime and its deployment assets
- adjust `serviceBase.image` in `config.yaml` if you want a different tag

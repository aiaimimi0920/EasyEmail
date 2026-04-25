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

## Notes

- the Docker build context is still the repository root, but the Dockerfile only
  copies the service runtime and its deployment assets
- adjust `serviceBase.image` in `config.yaml` if you want a different tag


# Publish Control Center Release Catalog

This helper publishes a release-set catalog JSON file to the control center
worker using credentials stored in the root `config.yaml`.

## Required Root Config

Fill these keys in `publishing.controlCenter`:

- `baseUrl`
- `releaseCatalogPublishPath`
- `releaseCatalogPayloadPath`
- `accessClientId`
- `accessClientSecret`
- `releasePublishToken`

## Usage

```powershell
Set-Location C:\Users\Public\nas_home\AI\GameEditor\EasyEmail
pwsh .\scripts\publish-control-center-release-catalog.ps1
```

You can override the payload file path explicitly:

```powershell
pwsh .\scripts\publish-control-center-release-catalog.ps1 `
  -PayloadPath C:\path\to\service-runtime-release-set-catalog.json
```

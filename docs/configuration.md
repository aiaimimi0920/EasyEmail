# Configuration

The repository uses a single operator-facing config file:

- `config.example.yaml`
- `config.yaml` copied from the example and kept local

## Sections

### `userscript`

Used by `scripts/compile-userscript.ps1`.

Required fields:

- `sourcePath`
- `outputPath`
- `secrets.cloudflare_customAuth`
- `secrets.cloudflare_adminAuth`
- `secrets.moemail_apiKey`
- `secrets.gptmail_apiKey`
- `secrets.im215_apiKey`

### `serviceBase`

Used by `scripts/compile-service-base-image.ps1`.

Required fields:

- `context`
- `dockerfile`
- `image`

### `cloudflareMail`

Used by `scripts/quick-deploy-cloudflare-mail.ps1`.

Required fields:

- `projectRoot`
- `workerDir`
- `frontendDir`
- `workerName`
- `workerEnv`
- `buildFrontend`
- `deployWorker`
- `syncRouting`
- `routing.mode`
- `routing.planPath`
- `routing.controlCenterDnsToken`
- `routing.cloudflareGlobalAuth.authEmail`
- `routing.cloudflareGlobalAuth.globalApiKey`

## Security Rules

- never commit `config.yaml`
- never commit generated local userscripts
- never commit live tokens or auth keys into example files


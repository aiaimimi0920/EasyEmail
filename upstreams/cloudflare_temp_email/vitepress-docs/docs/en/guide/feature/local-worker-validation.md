# Isolated validation of the complete Worker

The local build entry does not read EasyEmail root `config.yaml` or use production domains or credentials.
In `worker/`, use pnpm 10.10.0 to install the worker-specific lock and apply the existing Telegraf patch:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm build:local /absolute/isolated/output
```

The output path must be absolute and must not already contain `bundle` or the local configuration.
The script builds the complete `src/worker.ts` with `.test` domains, a placeholder D1 ID and a synthetic JWT secret,
using Wrangler `deploy --dry-run` without uploading. Legacy root-config `build/dev/deploy` behavior is unchanged.
Never use the synthetic configuration for a public deployment.

The EasyEmail aggregator's `npm run test:upstream` uses isolated D1 and the complete entry over a two-Worker HTTP chain.
Install aggregator dependencies first and set an absolute `EASYEMAIL_TEST_ROOT`; Windows paths must leave room for SQLite journal/WAL filenames.
Coverage includes the E2E receive endpoint and the local native email trigger, gzip, attachment digests, authentication, deletion and scheduled cleanup.

Storage failures now reject receipt and stop subsequent actions. Administrator mailbox deletion cleans related rows before the address,
and scheduled mailbox cleanup uses an atomic D1 batch. These D1 operations do not claim KV/S3 cleanup.
All four bulk address-cleanup modes bind one D1-computed cutoff to prevent the selection from expanding when a batch crosses a second; regressions cover both selection rules and a real cross-second batch.
No new environment variables, production endpoints or schema migrations are introduced.
Simulated local delivery is not public Email Routing/SMTP acceptance; optional external integrations need separate validation.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(workerRoot, '..', '..', '..');
const rootConfig = path.join(projectRoot, 'config.yaml');
const renderer = path.join(projectRoot, 'scripts', 'render-derived-configs.py');
const tempWrangler = path.join(projectRoot, '.tmp', 'cloudflare_temp_email.wrangler.toml');

const mode = process.argv[2] || 'build';
const extraArgs = process.argv.slice(3);

function fail(message, result) {
  if (result && typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
  console.error(message);
  process.exit(1);
}

if (!existsSync(rootConfig)) {
  fail(`Missing root config: ${rootConfig}`);
}

const renderResult = spawnSync(
  process.platform === 'win32' ? 'python' : 'python3',
  [
    renderer,
    '--root-config',
    rootConfig,
    '--worker-output',
    tempWrangler,
  ],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  },
);

if (renderResult.status !== 0) {
  fail('Failed to render worker config.', renderResult);
}

const wranglerBin = process.platform === 'win32'
  ? path.join(workerRoot, 'node_modules', '.bin', 'wrangler.cmd')
  : path.join(workerRoot, 'node_modules', '.bin', 'wrangler');

const wranglerArgsByMode = {
  build: ['deploy', '--config', tempWrangler, '--dry-run', '--outdir', 'dist', '--minify'],
  deploy: ['deploy', '--config', tempWrangler, '--minify'],
  dev: ['dev', '--config', tempWrangler],
};

if (!wranglerArgsByMode[mode]) {
  fail(`Unsupported worker mode: ${mode}`);
}

const wranglerResult = spawnSync(
  wranglerBin,
  [...wranglerArgsByMode[mode], ...extraArgs],
  {
    cwd: workerRoot,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  },
);

if (wranglerResult.status !== 0) {
  fail(`wrangler ${mode} failed.`, wranglerResult);
}

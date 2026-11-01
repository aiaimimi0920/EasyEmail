import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildApplication } from './build.mjs';
import { deploymentPlan } from './deployment-config.mjs';
import { artifactManifest, readDeployment, releaseInputs, sha256, verifyRelease, workspace } from './release-artifacts.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
function copyTree(from, to) {
  assert.ok(!fs.lstatSync(from).isSymbolicLink(), 'Build symlinks are forbidden');
  if (fs.statSync(from).isDirectory()) {
    fs.mkdirSync(to, { recursive: true }); for (const file of fs.readdirSync(from)) copyTree(path.join(from, file), path.join(to, file));
  } else { assert.ok(fs.statSync(from).isFile(), 'Only regular build artifacts are supported'); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); }
}
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });

export async function prepareRelease(descriptor, output) {
  const plan = await deploymentPlan(descriptor);
  assert.ok(path.isAbsolute(output), 'An absolute new output directory is required');
  assert.ok(!fs.existsSync(output), 'Output already exists; nothing will be overwritten');
  const parent = fs.realpathSync(path.dirname(output)), actualOutput = path.join(parent, path.basename(output)), sourceRoot = fs.realpathSync(workspace);
  const relative = path.relative(sourceRoot, actualOutput); assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'Release output must be outside the source workspace');
  const before = releaseInputs(); fs.mkdirSync(actualOutput);
  const evidence = path.join(actualOutput, 'evidence'), candidate = path.join(actualOutput, 'candidate'); fs.mkdirSync(evidence); fs.mkdirSync(candidate);
  const env = { ...process.env, TEMP: evidence, TMP: evidence, CI: 'true', WRANGLER_SEND_METRICS: 'false',
    CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_API_KEY: '', CLOUDFLARE_EMAIL: '', CLOUDFLARE_ACCOUNT_ID: '',
    CF_API_TOKEN: '', CF_API_KEY: '', CF_EMAIL: '', CF_ACCOUNT_ID: '',
    XDG_CONFIG_HOME: path.join(evidence, 'home'), WRANGLER_LOG_PATH: path.join(evidence, 'wrangler.log') }; fs.mkdirSync(env.XDG_CONFIG_HOME);
  const execute = (name, args, cwd) => {
    const result = spawnSync(process.execPath, args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    fs.writeFileSync(path.join(evidence, `${name}.log`), result.stdout ?? '', 'utf8'); fs.writeFileSync(path.join(evidence, `${name}.stderr.log`), result.stderr ?? '', 'utf8');
    if (result.error || result.status !== 0) throw Error(`Release ${name} failed; inspect isolated evidence logs`);
  };
  try {
    const platformBuild = path.join(evidence, 'platform-build'), emailBuild = path.join(evidence, 'email-build'); await buildApplication(platformBuild);
    execute('email-build', [path.join(workspace, 'upstreams/cloudflare_temp_email/worker/scripts/build-local.mjs'), emailBuild], evidence);
    const platform = path.join(candidate, 'platform'), email = path.join(candidate, 'email'); fs.mkdirSync(platform); fs.mkdirSync(email);
    copyTree(path.join(platformBuild, 'worker.mjs'), path.join(platform, 'server/worker.mjs')); copyTree(path.join(platformBuild, 'worker.mjs.map'), path.join(platform, 'server/worker.mjs.map'));
    copyTree(path.join(platformBuild, 'web'), path.join(platform, 'web')); copyTree(path.join(packageRoot, 'migrations'), path.join(platform, 'migrations'));
    copyTree(path.join(emailBuild, 'bundle'), path.join(email, 'bundle')); copyTree(path.join(workspace, 'upstreams/cloudflare_temp_email/db/schema.sql'), path.join(email, 'schema.sql'));
    for (const component of ['email', 'platform']) writeJson(path.join(candidate, component, 'wrangler.json'), plan[component]);
    writeJson(path.join(candidate, 'target.json'), descriptor); writeJson(path.join(candidate, 'required-secrets.json'), { required: plan.requiredSecrets, optional: plan.optionalSecrets });
    const require = createRequire(path.join(packageRoot, 'package.json')), meta = require.resolve('wrangler/package.json'), cli = path.join(path.dirname(meta), JSON.parse(fs.readFileSync(meta, 'utf8')).bin.wrangler);
    for (const component of ['email', 'platform']) execute(`${component}-dry-run`, [cli, 'deploy', '--dry-run', '--config', path.join(candidate, component, 'wrangler.json'), '--outdir', path.join(evidence, `${component}-dry-run`)], evidence);
    assert.deepEqual(releaseInputs(), before, 'Release source changed during preparation');
    const toolchains = Object.fromEntries(['service/cloudflare/package.json', 'upstreams/cloudflare_temp_email/worker/package.json'].map(file => {
      const value = JSON.parse(fs.readFileSync(path.join(workspace, file), 'utf8')); return [file, { name: value.name, version: value.version, devDependencies: value.devDependencies, packageManager: value.packageManager ?? null }];
    }));
    const manifest = { version: 1, status: 'prepared-not-deployed', atUtc: new Date().toISOString(), remoteWrites: false, remoteResourcesVerified: false,
      sourceStable: true, source: before, toolchains, files: artifactManifest(candidate), remainingGates: plan.remainingGates };
    writeJson(path.join(candidate, 'release.json'), manifest); const digest = sha256(fs.readFileSync(path.join(candidate, 'release.json')));
    const verification = await verifyRelease(candidate, digest); writeJson(path.join(evidence, 'result.json'), { status: 'passed', verification, remoteWrites: false });
    return { ...verification, status: 'prepared-not-deployed', evidence };
  } catch (error) { writeJson(path.join(evidence, 'failure.json'), { status: 'failed', error: error.message, remoteWrites: false }); throw error; }
}

async function main(args) {
  if (args[0] === 'plan' && args.length === 2) return deploymentPlan(readDeployment(path.resolve(args[1])));
  if (args[0] === 'prepare' && args.length === 3) return prepareRelease(readDeployment(path.resolve(args[1])), args[2]);
  if (args[0] === 'verify' && [2, 3].includes(args.length)) return verifyRelease(args[1], args[2]);
  throw Error('Usage: node scripts/prepare-release.mjs plan <descriptor.json> | prepare <descriptor.json> <absolute-new-output> | verify <absolute-candidate> [manifest-sha256]');
}
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}

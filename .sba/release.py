"""Build in sibling isolated checkouts using pinned public dependencies. No cloud writes."""
import argparse
import json
import os
from pathlib import Path

from boundary import digest, exact, matches, require
from build_environment import BuildRunner
from configuration import descriptor, preview_configuration
from contract import validated_request


ROOT = Path(__file__).resolve().parents[1]


def checkout_application(runner, git, output, source_sha, *, fetch_source=False):
    source = output / 'EasyEmail'
    runner.run([git, 'clone', '--no-hardlinks', '--no-checkout', ROOT, source], output, 'application-clone')
    runner.run([git, 'remote', 'set-url', 'origin', 'https://github.com/aiaimimi0920/EasyEmail.git'], source, 'application-origin')
    if fetch_source:
        runner.run([git, '-c', 'http.sslVerify=true', 'fetch', '--depth=1', 'origin', source_sha], source, 'application-fetch')
    runner.run([git, 'checkout', '--detach', source_sha], source, 'application-checkout')
    require(runner.output([git, 'rev-parse', 'HEAD'], source) == source_sha, 'EASYEMAIL_SOURCE_MISMATCH')
    return source


def prepare_release(request, output, *, fetch_source=False):
    """The entrypoint must pass the request returned by validated_request(), before any build outputs exist."""
    output = Path(output).resolve()
    require(not output.is_relative_to(ROOT) and not output.exists(), 'EASYEMAIL_BUILD_PATH_INVALID')
    runner = BuildRunner(output)
    git, node = runner.executable('git'), runner.executable('node')
    require(runner.output([node, '--version'], output).startswith('v22.'), 'EASYEMAIL_TOOLCHAIN_UNAVAILABLE')
    dependencies = json.loads((ROOT / '.sba/dependencies.json').read_text(encoding='utf8'))
    exact(dependencies, ['neuroDesign', 'npm', 'pnpm']); exact(dependencies['neuroDesign'], ['repository', 'commit'])
    neuro = dependencies['neuroDesign']
    require(neuro['repository'] == 'https://github.com/aiaimimi0920/NeuroDesign.git' and matches(r'[a-f0-9]{40}', neuro['commit']))
    require(matches(r'\d+\.\d+\.\d+', dependencies['npm']) and matches(r'\d+\.\d+\.\d+', dependencies['pnpm']))
    source = checkout_application(runner, git, output, request['sourceSha'], fetch_source=fetch_source)
    design = output / 'NeuroDesign'
    runner.run([git, 'init', design], output, 'design-init')
    runner.run([git, 'remote', 'add', 'origin', neuro['repository']], design, 'design-origin')
    runner.run([git, '-c', 'http.sslVerify=true', 'fetch', '--depth=1', 'origin', neuro['commit']], design, 'design-fetch')
    runner.run([git, 'checkout', '--detach', 'FETCH_HEAD'], design, 'design-checkout')
    require(runner.output([git, 'rev-parse', 'HEAD'], design) == neuro['commit'], 'EASYEMAIL_DESIGN_SOURCE_MISMATCH')
    bootstrap = runner.executable('npm.cmd' if os.name == 'nt' else 'npm')
    tools = output / 'tools'
    runner.run([bootstrap, 'install', '--prefix', tools, '--ignore-scripts', '--no-audit', '--no-fund',
                'npm@' + dependencies['npm'], 'pnpm@' + dependencies['pnpm']], output, 'tools-install')
    npm = tools / 'node_modules/npm/bin/npm-cli.js'
    pnpm = tools / 'node_modules/pnpm/bin/pnpm.cjs'
    require(runner.output([node, npm, '--version'], output) == dependencies['npm'], 'EASYEMAIL_TOOLCHAIN_UNAVAILABLE')
    require(runner.output([node, pnpm, '--version'], output) == dependencies['pnpm'], 'EASYEMAIL_TOOLCHAIN_UNAVAILABLE')
    runner.run([node, npm, 'ci', '--no-audit', '--no-fund'], design, 'design-install')
    runner.run([node, design / 'scripts/build.mjs', '--library', '--theme', 'neuro'], design, 'design-build')
    platform, email = source / 'service/cloudflare', source / 'upstreams/cloudflare_temp_email/worker'
    runner.run([node, npm, 'ci', '--no-audit', '--no-fund'], platform, 'platform-install')
    runner.run([node, pnpm, 'install', '--frozen-lockfile'], email, 'email-install')
    preview = request['action'] == 'preview' or request['action'] == 'repair' and 'preview' in request['context']
    runtime_config = preview_configuration(request['configuration']) if preview else request['configuration']
    public_input = {'descriptor': descriptor(runtime_config), 'providers': runtime_config['settings']['providers'],
                    'metadata': {**{key: request[key] for key in ('applicationId', 'applicationVersion', 'sourceSha')},
                                 'configurationDigest': digest(request['configuration'])}}
    if preview: public_input['preview'] = True
    input_path = output / 'release-input.json'
    input_path.write_text(json.dumps(public_input, ensure_ascii=False) + '\n', encoding='utf8')
    runner.run([node, source / '.sba/prepare.mjs', input_path, output / 'release'], source, 'release-prepare')
    # Prove that the stamped entrypoints, not just the base candidate, remain valid Worker modules.
    wrangler = platform / 'node_modules/wrangler/bin/wrangler.js'
    for role in ('email', 'platform'):
        runner.run([node, wrangler, 'deploy', '--dry-run', '--config', output / f'release/publish/{role}/wrangler.json',
                    '--outdir', output / f'{role}-dry-run'], output, role + '-dry-run')
    for role, directory in [('application', source), ('design', design)]:
        require(not runner.output([git, 'status', '--porcelain=v1', '--untracked-files=all'], directory), 'EASYEMAIL_SOURCE_DIRTY')
    return output / 'release'


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True); parser.add_argument('--output', required=True)
    args = parser.parse_args()
    from application import read_request
    selected = validated_request(read_request(args.request), ROOT)
    prepare_release(selected, args.output)

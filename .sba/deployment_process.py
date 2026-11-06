"""Invoke pinned Wrangler only against the sealed release, with per-command secret scope."""
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

from boundary import DeploymentError, digest, require
from build_environment import build_environment
from private_files import protect_directory, secret_file


class DeploymentProcess:
    def __init__(self, request, release, directory, state, material):
        self.release, self.state, self.material = Path(release), state, material
        self.directory = Path(directory); self.directory.mkdir()
        self.environment = build_environment(self.directory)
        protect_directory(self.directory, self.environment)
        self.environment.update(WRANGLER_LOG='none', WRANGLER_LOG_SANITIZE='true')
        self.node = shutil.which('node', path=self.environment.get('PATH', self.environment.get('Path', '')))
        require(self.node, 'EASYEMAIL_TOOLCHAIN_UNAVAILABLE')
        self.source = self.release.parent / 'EasyEmail'
        self.wrangler = self.source / 'service/cloudflare/node_modules/wrangler/bin/wrangler.js'
        self.metadata = {**{key: request[key] for key in ('applicationId', 'applicationVersion', 'sourceSha')},
                         'configurationDigest': digest(request['configuration'])}
        self.proof = self.release / 'sba-release.json'
        self.proof_digest = hashlib.sha256(self.proof.read_bytes()).hexdigest()
        self.expected_path = self.directory / 'expected-metadata.json'
        self.expected_path.write_text(json.dumps(self.metadata) + '\n', encoding='utf8')

    def _run(self, args, *, token=False, code='EASYEMAIL_DEPLOY_COMMAND_FAILED'):
        environment = dict(self.environment)
        if token:
            environment['CLOUDFLARE_API_TOKEN'] = self.material.token
        try:
            result = subprocess.run([self.node, *map(str, args)], cwd=self.directory, env=environment,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600)
        except (OSError, subprocess.TimeoutExpired):
            raise DeploymentError(code) from None
        require(result.returncode == 0, code)

    def verify_seal(self):
        self._run([self.source / '.sba/release-stamp.mjs', 'verify', self.release / 'publish', self.proof,
                   self.proof_digest, self.expected_path], code='EASYEMAIL_RELEASE_CHANGED')

    def initialize_databases(self):
        self.verify_seal()
        email, platform = (self.release / 'publish' / role / 'wrangler.json' for role in ('email', 'platform'))
        self.state.before_write('email-schema-applied')
        self._run([self.wrangler, 'd1', 'execute', 'DB', '--remote', '--config', email,
                   '--file', self.release / 'publish/email/schema.sql'], token=True, code='EASYEMAIL_SCHEMA_APPLY_FAILED')
        self.state.before_write('platform-migrations-applied')
        self._run([self.wrangler, 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', platform],
                  token=True, code='EASYEMAIL_MIGRATION_APPLY_FAILED')

    def publish(self, role):
        self.verify_seal()
        path = self.directory / (role + '-secrets.json')
        # JSON avoids dotenv interpolation. This file is private, outside both source and the publish manifest.
        with secret_file(path) as output:
            json.dump(self.material.workers[role], output); output.flush(); os.fsync(output.fileno())
        try:
            self.state.before_write(role + '-worker-published')
            self._run([self.wrangler, 'deploy', '--config', self.release / 'publish' / role / 'wrangler.json',
                       '--secrets-file', path], token=True, code='EASYEMAIL_WORKER_DEPLOY_FAILED')
        finally:
            path.unlink()

    def migrate_platform(self):
        self.verify_seal()
        self.state.before_write('platform-migrations-applied')
        self._run([self.wrangler, 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', self.release / 'publish/platform/wrangler.json'],
                  token=True, code='EASYEMAIL_MIGRATION_APPLY_FAILED')

    def restore_database(self, role, path):
        require(role in ('email', 'platform'), 'EASYEMAIL_RESTORE_ROLE_INVALID')
        self.verify_seal()
        self.state.before_write(role + '-snapshot-imported')
        self._run([self.wrangler, 'd1', 'execute', 'DB', '--remote', '--config', self.release / 'publish' / role / 'wrangler.json',
                   '--file', path], token=True, code='EASYEMAIL_SNAPSHOT_IMPORT_FAILED')

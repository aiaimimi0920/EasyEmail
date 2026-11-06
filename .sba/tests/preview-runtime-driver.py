"""Actual preview orchestration against local native data; metadata/publish/import CLI are explicit fixtures."""
import json
import os
import sys
import urllib.request
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import preview_deploy
from boundary import digest
from cloud_transport import CloudApi, RuntimeClient
from object_snapshot import ObjectStore
from preview_copy import prepare_copy
from preview_provenance import RESULT_IDENTITY
from public_verify import ReleaseReader, verify_public
from runtime_bridge import Bridge
from test_deploy_secrets import secret_environment


inputs = json.loads(Path(sys.argv[1]).read_text(encoding='utf8'))
request = inputs['request']; source = request['context']['source']['configuration']; target = request['configuration']
source_bridge, target_bridge = Bridge(inputs['sourcePort']), Bridge(inputs['targetPort'])
class Router:
    def open(self, request, timeout):
        url = urlparse(request.full_url)
        remote = source_bridge if url.netloc in (urlparse(source[role]['origin']).netloc for role in ('email', 'platform')) else target_bridge
        if '/d1/database/' in url.path:
            remote = source_bridge if any(source[role]['database']['id'] in url.path for role in ('email', 'platform')) else target_bridge
        if url.netloc == 'export.synthetic.r2.cloudflarestorage.com':
            # Export download URLs are issued by the immediately preceding synchronous export call.
            remote = self.last_export
        if url.path.endswith('/export'): self.last_export = remote
        return remote.open(request, timeout)
router = Router()
class Process:
    def __init__(self, selected, release, directory, state, material): self.state = state
    def verify_seal(self): pass  # independently exercised by the packaged fixture and CLI unit tests
    def publish(self, role): self.state.before_write(role + '-worker-published')  # target is already the sealed candidate
    def command(self, command, sql=None):
        body = {'command': command, 'sql': sql}
        request = urllib.request.Request('http://127.0.0.1:' + str(inputs['commandPort']), data=json.dumps(body).encode('utf8'),
                                         headers={'Content-Type': 'application/json'})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=60) as response: assert response.status == 200
    def restore_database(self, role, path):
        self.state.before_write(role + '-snapshot-imported'); self.command('restore-' + role, Path(path).read_text(encoding='utf8'))
    def migrate_platform(self): self.state.before_write('platform-migrations-applied'); self.command('migrate')
with ExitStack() as stack:
    stack.enter_context(patch.dict(os.environ, {**secret_environment(), 'EE_ADMIN_PASSWORD': 'Synthetic-release-password-735296'}))
    stack.enter_context(patch.object(preview_deploy, 'prepare_release', return_value=Path(inputs['release'])))
    # The packaged fixture replaces the build checkout; execute its installed application runtime.
    stack.enter_context(patch.object(preview_deploy, 'prepare_copy', side_effect=lambda *args, **kwargs:
        prepare_copy(*args, **{**kwargs, 'application_root': Path(__file__).resolve().parents[2]})))
    stack.enter_context(patch.object(preview_deploy, 'DeploymentProcess', Process))
    stack.enter_context(patch.object(preview_deploy, 'CloudApi', side_effect=lambda account, token, state: CloudApi(account, token, state, router)))
    stack.enter_context(patch.object(preview_deploy, 'RuntimeClient', side_effect=lambda config, state: RuntimeClient(config, state, router)))
    stack.enter_context(patch.object(preview_deploy, 'ObjectStore', side_effect=lambda config, key, state: ObjectStore(config, key, state, router)))
    stack.enter_context(patch.object(preview_deploy, 'verify_public', side_effect=lambda value: verify_public(value, ReleaseReader(router).read)))
    stack.enter_context(patch.object(preview_deploy, 'source_state', side_effect=lambda config, api: {'localConfigurationDigest': digest(config)}))
    stack.enter_context(patch.object(preview_deploy, 'fresh_resources'))  # native empty D1/R2 is checked by import/restore
    stack.enter_context(patch.object(preview_deploy, 'verify_settings'))  # cloud metadata is covered independently
    result = preview_deploy.preview(request, Path(sys.argv[2]))
print(json.dumps({**{field: request[field] for field in RESULT_IDENTITY}, **result}))

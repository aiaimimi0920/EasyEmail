"""Actual destroy-preview orchestration and native R2; cloud resource metadata/DELETE are explicit fixtures."""
import json
import os
import sys
import urllib.request
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import preview_cleanup
from boundary import digest
from cleanup_fixtures import CleanupApi
from object_snapshot import ObjectStore
from preview_provenance import RESULT_IDENTITY
from public_verify import ReleaseReader, verify_public
from runtime_bridge import Bridge
from test_deploy_secrets import secret_environment


inputs = json.loads(Path(sys.argv[1]).read_text(encoding='utf8'))
request = inputs['request']; config = request['configuration']; bridge = Bridge(inputs['targetPort'])
events = []
def command(command, bucket, keys=None):
    request = urllib.request.Request('http://127.0.0.1:' + str(inputs['cleanupPort']),
        data=json.dumps({'command': command, 'bucket': bucket, 'keys': keys}).encode('utf8'), headers={'Content-Type': 'application/json'})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=30) as response:
        return json.loads(response.read())


class Api(CleanupApi):
    def __init__(self, account, token, state): super().__init__(config); self.state = state
    def request(self, method, suffix, payload=None, write=None, zone=None):
        if write: self.state.before_write(write); events.append(write)
        if suffix.startswith('/r2/buckets/') and '/objects' in suffix:
            name = suffix.split('/')[3]
            if method == 'DELETE': command('delete', name, payload)
            self.objects[name] = command('list', name) if method == 'GET' else [{'key': key} for key in payload]
        return super().request(method, suffix, payload, write, zone)
    def delete(self, suffix, *, write):
        self.state.before_write(write); events.append(write); super().delete(suffix, write=write)


with ExitStack() as stack:
    stack.enter_context(patch.dict(os.environ, {**secret_environment(), 'EE_ADMIN_PASSWORD': 'Synthetic-release-password-735296'}))
    stack.enter_context(patch.object(preview_cleanup, 'CloudApi', Api))
    stack.enter_context(patch.object(preview_cleanup, 'ObjectStore', side_effect=lambda config, key, state: ObjectStore(config, key, state, bridge)))
    stack.enter_context(patch.object(preview_cleanup, 'verify_public', side_effect=lambda value: verify_public(value, ReleaseReader(bridge).read)))
    stack.enter_context(patch.object(preview_cleanup, 'source_state', side_effect=lambda config, api: {'localConfigurationDigest': digest(config)}))
    result = preview_cleanup.destroy_preview(request, Path(sys.argv[2]))
print(json.dumps({'result': {**{field: request[field] for field in RESULT_IDENTITY}, **result}, 'events': events}))

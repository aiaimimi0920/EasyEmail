"""Native D1/R2 journal, management GET and object deletion; account metadata/Worker deletion remain fixtures."""
import base64
import json
import os
import sys
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cleanup_resume
from cleanup_repair import repair_cleanup
from cleanup_resume_fixtures import ResumeFixture
from cloud_transport import CloudApi
from runtime_bridge import Bridge
from test_deploy_secrets import secret_environment


port = int(sys.argv[1]); f = ResumeFixture(); api = f.api; bridge = Bridge(port)
seeds = {name: base64.b64encode(body).decode('ascii') for name, body in api.body.items()}
request = urllib.request.Request(f'http://127.0.0.1:{port}/seed', data=json.dumps({'objects': seeds}).encode('utf8'))
with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=30) as response:
    assert response.status == 200
original_request = api.request
def routed(method, suffix, payload=None, write=None, zone=None):
    if '/objects' in suffix: return api.remote.request(method, suffix, payload, write, zone)
    return original_request(method, suffix, payload, write, zone)
def query(database, sql, params=None, write=None):
    value = api.remote.query(database, sql, params, write)
    if write == 'cleanup-resume-claim-written' and api.fail:
        from boundary import DeploymentError
        raise DeploymentError('EASYEMAIL_CLOUD_REQUEST_FAILED')
    return value
def cloud(account, token, state):
    api.state = state; api.remote = CloudApi(account, token, state, bridge); api.transport = api.remote.transport; api.token = token
    return api
api.request = routed; api.query = query
with patch.dict(os.environ, secret_environment()), patch.object(cleanup_resume, 'CloudApi', side_effect=cloud):
    api.fail = True; first = repair_cleanup(f.request, f.root / 'first-native')
    assert first['status'] == 'unknown' and first['checks'] == [], first
    api.fail = None; second = repair_cleanup(f.successor(first), f.root / 'second-native')
print(json.dumps({'first': first, 'second': second, 'metadataWrites': api.writes}))

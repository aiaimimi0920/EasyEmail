"""Native local data exercise; cloud export/CLI are explicit loopback substitutes, not cloud deployment."""
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cloud_transport import CloudApi, OperationState, RuntimeClient
from deployment_secrets import deployment_secrets
from object_snapshot import ObjectStore
from runtime_acceptance import email_version, migrate_email, verify_administrator
from snapshot_bundle import private_directory
from snapshot_lifecycle import capture_backup
from update_preservation import prove_update_preserved
from runtime_bridge import Bridge
from test_deploy_secrets import secret_environment


config = json.loads(Path(sys.argv[1]).read_text(encoding='utf8'))
directory = private_directory(sys.argv[3]); state = OperationState(directory, 'dc-' + '2' * 32)
material = deployment_secrets(config, secret_environment()); bridge = Bridge(sys.argv[2])
api = CloudApi(config['accountId'], material.token, state, bridge)
runtime = RuntimeClient(config, state, bridge)
store = ObjectStore(config, material.workers['platform']['EASYEMAIL_SBA_CONTROL_SECRET'], state, bridge)
email_version(material, runtime)
source = {'configuration': config, 'sourceSha': 'b' * 40, 'applicationVersion': '1.0.0', 'taskId': 'dc-' + '2' * 32}
backup = capture_backup(api, store, source, material.archive_key, directory / 'backup')
# Same-schema native migration and restart substitute only for the cloud CLI, never for data/readiness checks.
with bridge.open(urllib.request.Request('https://local-upgrade.test/apply', method='POST', data=b'{}'), timeout=60) as response:
    assert response.status == 200
migrate_email(material, runtime)
prove_update_preserved(backup, api, store, config, directory / 'postupdate')
verify_administrator(config, material, runtime)
print(json.dumps({'status': 'passed', 'backupCreated': True, 'dataPreserved': True, 'cloudDeployment': False, 'writes': state.value['writes']}))

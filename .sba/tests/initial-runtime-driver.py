"""Test-only loopback transport; application code still constructs its real HTTPS requests."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cloud_transport import CloudApi, OperationState, RuntimeClient
from deployment_secrets import deployment_secrets
from initial_bootstrap import bootstrap
from test_deploy_secrets import secret_environment
from runtime_bridge import Bridge
from bootstrap_pristine import database_witness, empty_objects, pristine
from boundary import DeploymentError
from object_snapshot import ObjectStore


mode, path = sys.argv[1:3]
config = json.loads(Path(path).read_text(encoding='utf8'))
material = deployment_secrets(config, secret_environment())
if mode == 'material':
    print(json.dumps(material.workers))
else:
    state = OperationState(Path(sys.argv[4]), 'dc-' + '1' * 32)
    bridge = Bridge(sys.argv[3])
    api = CloudApi(config['accountId'], material.token, state, bridge); runtime = RuntimeClient(config, state, bridge)
    store = ObjectStore(config, material.workers['platform']['EASYEMAIL_SBA_CONTROL_SECRET'], state, bridge)
    before = pristine(config, material, api, runtime, store)
    assert not state.attempted
    bootstrap(config, material, api, runtime)
    assert database_witness(config, api) == before
    empty_objects(store)
    try: pristine(config, material, api, runtime, store)
    except DeploymentError: pass
    else: raise AssertionError('BOOTSTRAPPED_INSTANCE_ACCEPTED_AS_PRISTINE')
    print(json.dumps({'status': 'passed', 'writes': state.value['writes'], 'pristineRepairGatePassed': True}))

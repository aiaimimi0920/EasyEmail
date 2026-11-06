"""Independent repair of a schema-ready, empty isolation deployment; never replay its deploy."""
import json

from boundary import DeploymentError, require
from bootstrap_pristine import database_witness, empty_objects, pristine
from cloud_transport import CloudApi, OperationState, RuntimeClient
from configuration import isolated
from deployment_process import DeploymentProcess
from deployment_secrets import deployment_secrets
from initial_bootstrap import bootstrap
from initial_resources import verify_database_initialization
from managed_instance import managed_state
from object_snapshot import ObjectStore
from private_files import secret_file
from public_verify import verify_public
from published_settings import verify_settings
from release import prepare_release
from snapshot_bundle import private_directory


def repair(request, directory):
    config = request['configuration']
    require(request['context']['repairId'] == 'complete-empty-bootstrap'
            and request['context']['errorCode'] == 'EASYEMAIL_CLOUD_REQUEST_FAILED'
            and request['previous']['applicationVersion'] == '1.0.0' and isolated(config),
            'EASYEMAIL_BOOTSTRAP_REPAIR_NOT_SUPPORTED')
    material = deployment_secrets(config)
    directory = private_directory(directory); state = OperationState(directory, request['taskId']); checks = []
    try:
        release = prepare_release(request, directory / 'build')
        api = CloudApi(config['accountId'], material.token, state); runtime = RuntimeClient(config, state)
        process = DeploymentProcess(request, release, directory / 'cloud', state, material); process.verify_seal()
        verify_public({**request, **request['previous']})
        before = managed_state(config, api)
        verify_database_initialization(config, api, release)
        verify_settings(config, api, release, material.workers, before['domains'])
        store = ObjectStore(config, material.workers['platform']['EASYEMAIL_SBA_CONTROL_SECRET'], state)
        witness = pristine(config, material, api, runtime, store)
        checks.append({'id': 'pristine-bootstrap-state-verified', 'passed': True})
        with secret_file(directory / 'pristine-witness.json') as output:
            json.dump(witness, output)
        for role in ('email', 'platform'):
            require(managed_state(config, api) == before, 'EASYEMAIL_INSTANCE_CHANGED')
            process.publish(role)
        verify_settings(config, api, release, material.workers, before['domains'])
        require(pristine(config, material, api, runtime, store) == witness, 'EASYEMAIL_INSTANCE_CHANGED')
        bootstrap(config, material, api, runtime)
        verify_database_initialization(config, api, release)
        require(database_witness(config, api) == witness, 'EASYEMAIL_INSTANCE_CHANGED')
        empty_objects(store)
        require(managed_state(config, api) == before, 'EASYEMAIL_INSTANCE_CHANGED')
        checks += [{'id': item, 'passed': True} for item in ('administrator-login-verified', 'self-provider-authenticated',
                    'data-preserved', 'unchanged-resources-verified', 'side-effects-isolated')]
        checks.extend(verify_public(request))
        checks += [{'id': item, 'passed': True} for item in ('repair-completed', 'service-ready')]
        return {'status': 'succeeded', 'checks': checks}
    except Exception as error:
        return {'status': 'unknown' if state.attempted else 'failed', 'checks': checks,
                'errorCode': error.code if isinstance(error, DeploymentError) else 'EASYEMAIL_UNEXPECTED_FAILURE'}

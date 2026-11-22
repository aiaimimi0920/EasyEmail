"""Data-preserving completion after authenticated publication/bootstrap and failed public verification."""
from boundary import DeploymentError, require
from cloud_transport import CloudApi, OperationState, RuntimeClient
from configuration import isolated
from deployment_process import DeploymentProcess
from deployment_secrets import deployment_secrets
from email_routing import prepare_routing, bind_routing
from initial_resources import verify_database_initialization
from managed_instance import managed_state
from object_snapshot import ObjectStore
from public_verify import verify_public
from published_settings import verify_settings
from readiness_parent import verify_parent_assets
from release import prepare_release
from runtime_acceptance import email_version, verify_administrator
from snapshot_bundle import private_directory
from snapshot_lifecycle import capture_backup
from update_preservation import prove_update_preserved
from worker_download import verify_uploaded_worker


def repair_readiness(request, directory):
    config = request['configuration']; context = request['context']
    require(context['repairId'] == 'complete-fresh-readiness'
            and context['errorCode'] == 'EASYEMAIL_PUBLIC_VERIFICATION_FAILED'
            and request['previous']['applicationVersion'] == '1.0.13'
            and not isolated(config) and config['routing'] is not None, 'EASYEMAIL_READINESS_REPAIR_NOT_SUPPORTED')
    material = deployment_secrets(config)
    directory = private_directory(directory); state = OperationState(directory, request['taskId']); checks = []
    try:
        api = CloudApi(config['accountId'], material.token, state); runtime = RuntimeClient(config, state)
        parent = {**request, **request['previous'], 'taskId': context['parentTaskId'], 'action': 'repair', 'previous': None}
        previous = prepare_release(parent, directory / 'parent', fetch_source=True)
        for role in ('email', 'platform'): verify_uploaded_worker(config, api, previous, role)
        # Routing is witnessed independently as neutral until the final, fully verified promotion.
        targets = {**config, 'routing': None}
        before = managed_state(targets, api); routing = prepare_routing(config, api)
        verify_settings(config, api, previous, material.workers, before['domains'])
        verify_database_initialization(config, api, previous); email_version(material, runtime)
        verify_parent_assets(parent, previous)
        checks.append({'id': 'previous-workers-and-origin-assets-authenticated', 'passed': True})
        release = prepare_release(request, directory / 'build')
        process = DeploymentProcess(request, release, directory / 'cloud', state, material); process.verify_seal()
        store = ObjectStore(config, material.workers['platform']['EASYEMAIL_SBA_CONTROL_SECRET'], state)
        source = {'configuration': config, **request['previous'], 'taskId': request['taskId']}
        backup = capture_backup(api, store, source, material.archive_key, directory / 'backup')
        checks.append({'id': 'backup-created', 'passed': True})
        require(managed_state(targets, api) == before and prepare_routing(config, api) == routing, 'EASYEMAIL_INSTANCE_CHANGED')
        for role in ('email', 'platform'): verify_uploaded_worker(config, api, previous, role)
        for role in ('email', 'platform'):
            require(managed_state(targets, api) == before, 'EASYEMAIL_INSTANCE_CHANGED')
            process.publish(role)
        verify_settings(config, api, release, material.workers, before['domains'])
        verify_database_initialization(config, api, release); email_version(material, runtime)
        prove_update_preserved(backup, api, store, config, directory / 'postupdate')
        require(managed_state(targets, api) == before, 'EASYEMAIL_INSTANCE_CHANGED')
        checks.append({'id': 'data-preserved', 'passed': True})
        verify_administrator(config, material, runtime)
        checks += [{'id': item, 'passed': True} for item in ('administrator-login-verified', 'self-provider-authenticated')]
        checks.extend(verify_public(request))
        bind_routing(config, api, routing)
        checks += [{'id': item, 'passed': True} for item in ('email-routing-bound-readback', 'unchanged-resources-verified',
                                                            'repair-completed', 'service-ready')]
        return {'status': 'succeeded', 'checks': checks}
    except Exception as error:
        return {'status': 'unknown' if state.attempted else 'failed', 'checks': checks,
                'errorCode': error.code if isinstance(error, DeploymentError) else 'EASYEMAIL_UNEXPECTED_FAILURE'}

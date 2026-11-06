"""Independent completion of a proven pristine partial fresh publication; never replay deploy."""
from boundary import DeploymentError, require
from bootstrap_pristine import uninitialized_databases
from cloud_transport import CloudApi, OperationState, RuntimeClient
from configuration import isolated
from data_resources import data_identity
from deployment_process import DeploymentProcess
from deployment_secrets import deployment_secrets
from email_routing import prepare_routing, bind_routing
from initial_bootstrap import bootstrap
from production_domains import free_domains, recheck_domain
from publication_state import partial_state
from published_settings import verify_settings
from public_verify import verify_public
from release import prepare_release
from snapshot_bundle import private_directory
from worker_download import verify_uploaded_email


def repair_publication(request, directory):
    config = request['configuration']; context = request['context']
    require(context['repairId'] == 'complete-fresh-publication'
            and context['errorCode'] == 'EASYEMAIL_WORKER_DEPLOY_FAILED'
            and request['previous']['applicationVersion'] == '1.0.12'
            and not isolated(config) and config['routing'] is not None,
            'EASYEMAIL_PUBLICATION_REPAIR_NOT_SUPPORTED')
    material = deployment_secrets(config)
    directory = private_directory(directory); state = OperationState(directory, request['taskId']); checks = []
    try:
        api = CloudApi(config['accountId'], material.token, state); runtime = RuntimeClient(config, state)
        parent = {**request, **request['previous'], 'taskId': context['parentTaskId'], 'action': 'deploy', 'previous': None}
        previous = prepare_release(parent, directory / 'parent')
        verify_uploaded_email(config, api, previous)
        before = partial_state(config, api, previous, material.workers)
        domains = free_domains(config, api); routing = prepare_routing(config, api)
        checks.append({'id': 'pristine-partial-parent-verified', 'passed': True})
        release = prepare_release(request, directory / 'build')
        process = DeploymentProcess(request, release, directory / 'cloud', state, material)
        process.verify_seal()
        require(partial_state(config, api, previous, material.workers) == before, 'EASYEMAIL_INSTANCE_CHANGED')
        verify_uploaded_email(config, api, previous)
        for role in ('email', 'platform'):
            recheck_domain(config, role, api, domains[role])
            process.publish(role)
        verify_settings(config, api, release, material.workers, domains)
        require(uninitialized_databases(config, api) == before['databases'], 'EASYEMAIL_INSTANCE_CHANGED')
        require(data_identity(config, api, require_empty=False) == before['identity'], 'EASYEMAIL_INSTANCE_CHANGED')
        checks.append({'id': 'published-settings-readback', 'passed': True})
        bootstrap(config, material, api, runtime)
        checks += [{'id': item, 'passed': True} for item in ('administrator-login-verified', 'self-provider-authenticated')]
        checks.extend(verify_public(request))
        bind_routing(config, api, routing)
        checks += [{'id': item, 'passed': True} for item in ('email-routing-bound-readback', 'unchanged-resources-verified',
                                                            'repair-completed', 'service-ready')]
        return {'status': 'succeeded', 'checks': checks}
    except Exception as error:
        return {'status': 'unknown' if state.attempted else 'failed', 'checks': checks,
                'errorCode': error.code if isinstance(error, DeploymentError) else 'EASYEMAIL_UNEXPECTED_FAILURE'}

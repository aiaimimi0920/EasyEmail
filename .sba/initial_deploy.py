"""First deployment into fresh resources; custom domains and routing require explicit declarations."""
from pathlib import Path

from boundary import DeploymentError
from cloud_transport import CloudApi, OperationState, RuntimeClient
from configuration import isolated
from deployment_process import DeploymentProcess
from deployment_secrets import deployment_secrets
from initial_bootstrap import bootstrap
from initial_resources import fresh_resources, verify_database_initialization
from public_verify import verify_public
from published_settings import verify_settings
from production_domains import free_domains, recheck_domain
from email_routing import prepare_routing, bind_routing
from release import prepare_release


def deploy(request, directory):
    config = request['configuration']
    material = deployment_secrets(config)
    directory = Path(directory)
    directory.mkdir()
    state = OperationState(directory, request['taskId'])
    checks = []
    try:
        release = prepare_release(request, directory / 'build')
        api = CloudApi(config['accountId'], material.token, state)
        runtime = RuntimeClient(config, state)
        process = DeploymentProcess(request, release, directory / 'cloud', state, material)
        process.verify_seal()
        domains = free_domains(config, api)
        routing = prepare_routing(config, api)
        # The platform owns creation/locks; the application independently checks real identities and current empty state.
        resource_digest = fresh_resources(config, api)
        (directory / 'resource-identities.sha256').write_text(resource_digest + '\n', encoding='utf8')
        checks.append({'id': 'fresh-resources-verified', 'passed': True})
        process.initialize_databases()
        verify_database_initialization(config, api, release)
        checks.append({'id': 'database-initialization-verified', 'passed': True})
        for role in ('email', 'platform'):
            recheck_domain(config, role, api, domains.get(role))
            process.publish(role)
        verify_settings(config, api, release, material.workers, domains)
        checks.append({'id': 'published-settings-readback', 'passed': True})
        bootstrap(config, material, api, runtime)
        checks += [{'id': 'administrator-login-verified', 'passed': True}, {'id': 'self-provider-authenticated', 'passed': True}]
        if isolated(config): checks.append({'id': 'side-effects-isolated', 'passed': True})
        try:
            checks.extend(verify_public(request))
        except DeploymentError as error:
            # A requested mail target is still unbound: this is not a completed deployment awaiting verification.
            return {'status': 'unknown' if routing is not None else 'deployed-unverified', 'checks': checks, 'errorCode': error.code}
        bind_routing(config, api, routing)
        if routing is not None: checks.append({'id': 'email-routing-bound-readback', 'passed': True})
        return {'status': 'succeeded', 'checks': checks}
    except Exception as error:
        code = error.code if isinstance(error, DeploymentError) else 'EASYEMAIL_UNEXPECTED_FAILURE'
        return {'status': 'unknown' if state.attempted else 'failed', 'checks': checks, 'errorCode': code}

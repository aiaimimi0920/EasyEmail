"""Same-instance update: independently verified persistent backup precedes every upgrade write."""
import json
import os

from boundary import DeploymentError, require
from cloud_transport import CloudApi, OperationState, RuntimeClient
from configuration import isolated
from deployment_process import DeploymentProcess
from deployment_secrets import deployment_secrets
from initial_resources import verify_database_initialization
from managed_instance import managed_state
from object_snapshot import ObjectStore
from private_files import secret_file
from public_verify import verify_public
from published_settings import verify_settings
from release import prepare_release
from runtime_acceptance import email_version, migrate_email, verify_administrator
from snapshot_bundle import private_directory
from snapshot_lifecycle import capture_backup
from update_preservation import prove_update_preserved


def update(request, directory):
    config = request['configuration']; material = deployment_secrets(config)
    directory = private_directory(directory); state = OperationState(directory, request['taskId']); checks = []
    try:
        release = prepare_release(request, directory / 'build')
        api = CloudApi(config['accountId'], material.token, state); runtime = RuntimeClient(config, state)
        process = DeploymentProcess(request, release, directory / 'cloud', state, material)
        process.verify_seal()
        verify_public({**request, **request['previous']})
        before = managed_state(config, api)
        verify_settings(config, api, release, material.workers, before['domains'])
        email_version(material, runtime)
        checks.append({'id': 'previous-release-verified', 'passed': True})
        store = ObjectStore(config, material.workers['platform']['EASYEMAIL_SBA_CONTROL_SECRET'], state)
        source = {'configuration': config, **request['previous'], 'taskId': request['taskId']}
        backup = capture_backup(api, store, source, material.archive_key, directory / 'backup')
        with secret_file(directory / 'backup-reference.json') as file:
            json.dump({key: backup[key] for key in ('id', 'createdAt', 'object')}, file)
            file.flush(); os.fsync(file.fileno())
        checks.append({'id': 'backup-created', 'passed': True})
        require(managed_state(config, api) == before, 'EASYEMAIL_INSTANCE_CHANGED')
        process.migrate_platform()
        for role in ('email', 'platform'):
            require(managed_state(config, api) == before, 'EASYEMAIL_INSTANCE_CHANGED')
            process.publish(role)
            if role == 'email': migrate_email(material, runtime)
        verify_database_initialization(config, api, release)
        verify_settings(config, api, release, material.workers, before['domains'])
        require(managed_state(config, api) == before, 'EASYEMAIL_INSTANCE_CHANGED')
        prove_update_preserved(backup, api, store, config, directory / 'postupdate')
        checks.append({'id': 'data-preserved', 'passed': True})
        verify_administrator(config, material, runtime)
        checks += [{'id': 'administrator-login-verified', 'passed': True}, {'id': 'self-provider-authenticated', 'passed': True}]
        if isolated(config): checks.append({'id': 'side-effects-isolated', 'passed': True})
        try: checks.extend(verify_public(request))
        except DeploymentError as error:
            return {'status': 'deployed-unverified', 'checks': checks, 'errorCode': error.code}
        return {'status': 'succeeded', 'checks': checks}
    except Exception as error:
        return {'status': 'unknown' if state.attempted else 'failed', 'checks': checks,
                'errorCode': error.code if isinstance(error, DeploymentError) else 'EASYEMAIL_UNEXPECTED_FAILURE'}

"""Independent upgrade completion after a proven pre-write abort or post-publish receipt-schema rejection."""
import json
import os

from boundary import DeploymentError, matches, require, version
from cloud_transport import CloudApi, OperationState, RuntimeClient
from configuration import isolated
from deployment_process import DeploymentProcess
from deployment_secrets import deployment_secrets
from initial_resources import verify_database_initialization
from managed_instance import managed_state
from object_snapshot import ObjectStore, PRIVATE_PREFIX
from private_files import secret_file
from public_verify import RELEASE_PATH, ReleaseReader, json_body, verify_public
from published_settings import verify_settings
from release import prepare_release
from runtime_acceptance import email_version, migrate_email, verify_administrator
from snapshot_bundle import private_directory
from snapshot_lifecycle import capture_backup
from update_preservation import prove_update_preserved


ALLOWED_PREWRITE_ERRORS = (
    'EASYEMAIL_SOURCE_DATABASE_CHANGED',
    'EASYEMAIL_SOURCE_OBJECTS_CHANGED',
    'EASYEMAIL_BUILD_FAILED',
)
ALLOWED_REPAIR_ERRORS = (*ALLOWED_PREWRITE_ERRORS, 'SBA_RESULT_INVALID')


def active_live_release(request, read=None):
    read = read or ReleaseReader().read
    found = {}
    for role in ('email', 'platform'):
        marker = json_body(read(request['configuration'][role]['origin'] + RELEASE_PATH, limit=16384))
        require(isinstance(marker, dict) and marker.get('applicationId') == 'easyemail'
                and isinstance(marker.get('applicationVersion'), str)
                and isinstance(marker.get('sourceSha'), str) and matches(r'[a-f0-9]{40}', marker['sourceSha']),
                'EASYEMAIL_UPDATE_REPAIR_NOT_SUPPORTED')
        found[role] = (marker['applicationVersion'], marker['sourceSha'])
    require(found['email'] == found['platform'], 'EASYEMAIL_UPDATE_REPAIR_NOT_SUPPORTED')
    active_version, active_sha = found['email']
    require(active_sha != request['sourceSha'], 'EASYEMAIL_UPDATE_REPAIR_NOT_SUPPORTED')
    if request['context']['errorCode'] == 'SBA_RESULT_INVALID':
        require(active_version == request['previous']['applicationVersion']
                and active_sha == request['previous']['sourceSha'], 'EASYEMAIL_UPDATE_REPAIR_NOT_SUPPORTED')
    else:
        require(version(active_version) < version(request['previous']['applicationVersion'])
                and active_sha != request['previous']['sourceSha'], 'EASYEMAIL_UPDATE_REPAIR_NOT_SUPPORTED')
    return {'applicationVersion': active_version, 'sourceSha': active_sha}


def verify_parent_backup_state(store, parent_task_id, expect_present):
    matched = [row for row in store.list('OUTBOX')
               if row['key'].startswith(PRIVATE_PREFIX + 'backups/')
               and row['customMetadata'].get('task') == parent_task_id]
    if expect_present:
        require(len(matched) == 1, 'EASYEMAIL_PARENT_BACKUP_MISSING')
    else:
        require(not matched, 'EASYEMAIL_PARENT_BACKUP_ALREADY_PERSISTED')


def repair_prewrite_update(request, directory):
    config = request['configuration']; context = request['context']
    require(context['repairId'] == 'complete-prewrite-update'
            and context['errorCode'] in ALLOWED_REPAIR_ERRORS
            and version(request['previous']['applicationVersion']) < version(request['applicationVersion']),
            'EASYEMAIL_UPDATE_REPAIR_NOT_SUPPORTED')
    material = deployment_secrets(config)
    directory = private_directory(directory); state = OperationState(directory, request['taskId']); checks = []
    parent_published = context['errorCode'] == 'SBA_RESULT_INVALID'
    try:
        release = prepare_release(request, directory / 'build')
        api = CloudApi(config['accountId'], material.token, state); runtime = RuntimeClient(config, state)
        process = DeploymentProcess(request, release, directory / 'cloud', state, material)
        process.verify_seal()
        active = active_live_release(request)
        verify_public({**request, **active})
        before = managed_state(config, api)
        verify_settings(config, api, release, material.workers, before['domains'])
        email_version(material, runtime)
        store = ObjectStore(config, material.workers['platform']['EASYEMAIL_SBA_CONTROL_SECRET'], state)
        verify_parent_backup_state(store, context['parentTaskId'], expect_present=parent_published)
        checks += [{'id': 'parent-published-release-verified' if parent_published else 'parent-prewrite-abort-verified',
                    'passed': True},
                   {'id': 'previous-release-verified', 'passed': True}]
        source = {'configuration': config, **active, 'taskId': request['taskId']}
        backup = capture_backup(api, store, source, material.archive_key, directory / 'backup', attempts=4)
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
        checks.append({'id': 'unchanged-resources-verified', 'passed': True})
        prove_update_preserved(backup, api, store, config, directory / 'postupdate')
        checks.append({'id': 'data-preserved', 'passed': True})
        verify_administrator(config, material, runtime)
        checks += [{'id': 'administrator-login-verified', 'passed': True},
                   {'id': 'self-provider-authenticated', 'passed': True}]
        if isolated(config): checks.append({'id': 'side-effects-isolated', 'passed': True})
        checks.extend(verify_public(request))
        checks += [{'id': 'repair-completed', 'passed': True}, {'id': 'service-ready', 'passed': True}]
        return {'status': 'succeeded', 'checks': checks}
    except Exception as error:
        return {'status': 'unknown' if state.attempted else 'failed', 'checks': checks,
                'errorCode': error.code if isinstance(error, DeploymentError) else 'EASYEMAIL_UNEXPECTED_FAILURE'}

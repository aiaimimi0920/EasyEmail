"""Pre-upgrade copy lifecycle: snapshot first, isolated copy migration, source proof, private provenance."""
from boundary import DeploymentError, require
from cloud_transport import CloudApi, OperationState, RuntimeClient
from deployment_process import DeploymentProcess
from initial_resources import fresh_resources, verify_database_initialization
from object_snapshot import ObjectStore
from preview_copy import prepare_copy, verify_preview_policy
from preview_credentials import preview_material
from preview_provenance import persist_provenance
from preview_source import source_state, prove_source_unchanged
from public_verify import verify_public
from published_settings import verify_settings
from release import prepare_release
from runtime_acceptance import email_version, migrate_email, verify_administrator
from snapshot_bundle import private_directory
from snapshot_lifecycle import capture_backup
from update_preservation import prove_update_preserved


def preview(request, directory):
    config = request['configuration']; source = request['context']['source']; source_config = source['configuration']
    require(config['settings']['adminUsername'] == source_config['settings']['adminUsername'], 'EASYEMAIL_PREVIEW_ADMIN_MISMATCH')
    original, copied = preview_material(source_config, config)
    directory = private_directory(directory); state = OperationState(directory, request['taskId']); checks = []
    try:
        release = prepare_release(request, directory / 'build')
        api = CloudApi(config['accountId'], original.token, state)
        process = DeploymentProcess(request, release, directory / 'cloud', state, copied)
        process.verify_seal(); verify_preview_policy(release, config)
        source_request = {**request, **source}
        verify_public(source_request); before = source_state(source_config, api)
        email_version(original, RuntimeClient(source_config, state))
        fresh_resources(config, api)
        source_store = ObjectStore(source_config, original.workers['platform']['EASYEMAIL_SBA_CONTROL_SECRET'], state)
        snapshot_source = {field: source[field] for field in ('configuration', 'sourceSha', 'applicationVersion', 'taskId')}
        backup = capture_backup(api, source_store, snapshot_source, original.archive_key, directory / 'backup')
        require(source_state(source_config, api) == before, 'EASYEMAIL_SOURCE_INSTANCE_CHANGED')
        fresh_resources(config, api)
        # Publish only sealed side-effect-isolated entrypoints; the databases are still empty here.
        for role in ('email', 'platform'): process.publish(role)
        verify_settings(config, api, release, copied.workers)
        target_state = source_state(config, api)
        store = ObjectStore(config, copied.workers['platform']['EASYEMAIL_SBA_CONTROL_SECRET'], state)
        prepared = prepare_copy(backup, store, source_config, config, original, copied)
        for role in ('email', 'platform'): process.restore_database(role, prepared[role + 'Sql'])
        checks.append({'id': 'snapshot-copied', 'passed': True})
        process.migrate_platform(); runtime = RuntimeClient(config, state); migrate_email(copied, runtime)
        verify_database_initialization(config, api, release)
        prove_update_preserved(prepared['backup'], api, store, config, directory / 'targetcheck')
        checks.append({'id': 'migration-verified', 'passed': True})
        verify_settings(config, api, release, copied.workers)
        require(source_state(config, api) == target_state, 'EASYEMAIL_PREVIEW_TARGET_CHANGED')
        verify_administrator(config, copied, runtime); checks.extend(verify_public(request))
        verify_public(source_request)
        prove_source_unchanged(backup, api, source_store, source_config, directory / 'sourcefinal')
        require(source_state(source_config, api) == before, 'EASYEMAIL_SOURCE_INSTANCE_CHANGED')
        checks += [{'id': 'source-unchanged', 'passed': True}, {'id': 'side-effects-isolated', 'passed': True}]
        result = {'status': 'succeeded', 'checks': checks, 'lifecycle': {
            'resources': [{'key': row['key'], 'status': 'created'} for row in request['context']['resources']],
            'urls': request['context']['urls'], 'snapshot': {key: backup[key] for key in ('id', 'createdAt')}}}
        persist_provenance(request, result, target_state, store, copied.archive_key, directory)
        return result
    except Exception as error:
        return {'status': 'unknown' if state.attempted else 'failed', 'checks': checks,
                'errorCode': error.code if isinstance(error, DeploymentError) else 'EASYEMAIL_UNEXPECTED_FAILURE'}

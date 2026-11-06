"""Independent completion of the exact schema-empty, object-restored 1.0.2 preview failure."""
from boundary import DeploymentError, require
from cloud_transport import CloudApi, OperationState, RuntimeClient
from configuration import isolated
from deployment_process import DeploymentProcess
from initial_resources import verify_database_initialization
from object_snapshot import ObjectStore, business_inventory
from preview_copy import prepare_restored_copy, verify_preview_policy
from preview_credentials import preview_material
from preview_provenance import persist_provenance
from preview_repair_state import load_source_backup, empty_database, empty_databases, reuse_objects
from preview_source import source_state, prove_source_unchanged, capture_source_witness
from public_verify import verify_public
from published_settings import verify_settings
from release import prepare_release
from runtime_acceptance import email_version, migrate_email, verify_administrator
from snapshot_bundle import private_directory
from update_preservation import prove_update_preserved


def repair_preview(request, directory):
    context = request['context']; preview = context['preview']; config = request['configuration']
    source = preview['source']; source_config = source['configuration']
    previous = request['previous']; baseline = context.get('previewBaseline', previous)
    initial = context['errorCode'] == 'EASYEMAIL_PREVIEW_CREDENTIAL_FAILED' and previous['applicationVersion'] == '1.0.2' and all(baseline[k] == previous[k] for k in previous)
    continuation = context['errorCode'] == 'EASYEMAIL_SOURCE_DATABASE_CHANGED' and previous['applicationVersion'] == '1.0.4' and 'previewBaseline' in context
    require(context['repairId'] == 'complete-preview-credentials' and (initial or continuation)
            and baseline['applicationVersion'] == '1.0.2' and source['applicationVersion'] == '1.0.0'
            and isolated(config) and isolated(source_config) and config['routing'] is source_config['routing'] is None,
            'EASYEMAIL_PREVIEW_REPAIR_NOT_SUPPORTED')
    original, copied = preview_material(source_config, config)
    directory = private_directory(directory); state = OperationState(directory, request['taskId']); checks = []
    try:
        release = prepare_release(request, directory / 'build'); verify_preview_policy(release, config)
        api = CloudApi(config['accountId'], original.token, state)
        process = DeploymentProcess(request, release, directory / 'cloud', state, copied); process.verify_seal()
        source_request = {**request, **source}
        verify_public(source_request); verify_public({**request, **baseline})
        before_source = source_state(source_config, api); before_target = source_state(config, api)
        verify_settings(config, api, release, copied.workers)
        email_version(original, RuntimeClient(source_config, state))
        source_store = ObjectStore(source_config, original.workers['platform']['EASYEMAIL_SBA_CONTROL_SECRET'], state)
        target_store = ObjectStore(config, copied.workers['platform']['EASYEMAIL_SBA_CONTROL_SECRET'], state)
        backup = load_source_backup(source, source_store, original.archive_key, directory / 'backup')
        empty_databases(config, api)
        restored = reuse_objects(target_store, backup, directory / 'platform-rebound.sql')
        prepared = prepare_restored_copy(backup, restored, source_config, config, original, copied, application_root=release.parent / 'EasyEmail')
        # Restore the original authenticated snapshot; compare the live source before/after this operation.
        current_source = capture_source_witness(api, source_store, source_config, directory / 'sourcebefore')
        require(source_state(source_config, api) == before_source and source_state(config, api) == before_target,
                'EASYEMAIL_SOURCE_INSTANCE_CHANGED')
        expected = {bucket: sorted([row['target'] for row in restored['copies'] if row['bucket'] == bucket], key=lambda row: row['key'])
                    for bucket in ('INBOX', 'OUTBOX')}
        require(business_inventory(target_store) == expected, 'EASYEMAIL_PREVIEW_REPAIR_OBJECTS_CHANGED')
        empty_databases(config, api)
        checks.append({'id': 'partial-preview-state-verified', 'passed': True})
        for role in ('email', 'platform'): process.publish(role)
        verify_settings(config, api, release, copied.workers); target_state = source_state(config, api)
        for role in ('email', 'platform'):
            empty_database(config, role, api); process.restore_database(role, prepared[role + 'Sql'])
        checks.append({'id': 'snapshot-copied', 'passed': True})
        process.migrate_platform(); runtime = RuntimeClient(config, state); migrate_email(copied, runtime)
        verify_database_initialization(config, api, release)
        prove_update_preserved(prepared['backup'], api, target_store, config, directory / 'targetcheck')
        checks.append({'id': 'migration-verified', 'passed': True})
        verify_settings(config, api, release, copied.workers)
        require(source_state(config, api) == target_state, 'EASYEMAIL_PREVIEW_TARGET_CHANGED')
        verify_administrator(config, copied, runtime); checks.extend(verify_public(request))
        verify_public(source_request)
        prove_source_unchanged(current_source, api, source_store, source_config, directory / 'sourcefinal')
        require(source_state(source_config, api) == before_source, 'EASYEMAIL_SOURCE_INSTANCE_CHANGED')
        checks += [{'id': name, 'passed': True} for name in ('source-unchanged', 'side-effects-isolated', 'repair-completed',
                    'data-preserved', 'unchanged-resources-verified', 'service-ready')]
        result = {'status': 'succeeded', 'checks': checks, 'lifecycle': {
            'resources': [{'key': row['key'], 'status': 'created'} for row in preview['resources']], 'urls': preview['urls'],
            'snapshot': {key: backup[key] for key in ('id', 'createdAt')}}}
        persist_provenance(request, result, target_state, target_store, copied.archive_key, directory)
        return result
    except Exception as error:
        return {'status': 'unknown' if state.attempted else 'failed', 'checks': checks,
                'errorCode': error.code if isinstance(error, DeploymentError) else 'EASYEMAIL_UNEXPECTED_FAILURE'}

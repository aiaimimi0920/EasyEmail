"""Destroy only an authenticated, unshared preview; consume durable authority before stopping ingress."""
import json
import os

from boundary import DeploymentError, require
from cloud_transport import CloudApi, OperationState
from cleanup_buckets import bucket_identity, inspect_bucket, remove_bucket
from cleanup_references import verify_unshared
from cleanup_resources import database_absent, database_identity, remove_database, remove_worker, stop_ingress, worker_absent
from configuration import preview_configuration
from deployment_secrets import deployment_secrets
from object_snapshot import ObjectStore
from preview_provenance import load_provenance, consume_provenance, cleanup_key
from preview_source import source_state
from public_verify import verify_public
from snapshot_bundle import private_directory


def destroy_preview(request, directory):
    config = request['configuration']; runtime_config = preview_configuration(config)
    material = deployment_secrets(runtime_config, {**os.environ, 'EE_PROVIDER_SECRETS': '{}'})
    directory = private_directory(directory); state = OperationState(directory, request['taskId']); checks = []
    statuses = {row['key']: 'unknown' for row in request['context']['resources']}
    try:
        api = CloudApi(config['accountId'], material.token, state)
        store = ObjectStore(config, material.workers['platform']['EASYEMAIL_SBA_CONTROL_SECRET'], state)
        proof = load_provenance(request, store, material.archive_key, directory)
        require(source_state(config, api) == proof['state'], 'EASYEMAIL_PREVIEW_TARGET_CHANGED')
        verify_public(request); verify_unshared(config, api)
        databases = {role: database_identity(config, role, api) for role in ('email', 'platform')}
        buckets = {field: inspect_bucket(api, config['platform'][field]) for field in ('inboxBucket', 'outboxBucket')}
        planned_keys = [row['key'] for row in buckets['outboxBucket']['objects']] + [cleanup_key(request)]
        require(len(planned_keys) <= 1000 and len(json.dumps(planned_keys, ensure_ascii=False, separators=(',', ':')).encode('utf8')) <= 262144,
                'EASYEMAIL_PREVIEW_CLEANUP_CAPACITY_EXCEEDED')
        checks.append({'id': 'preview-authority-verified', 'passed': True})
        # Conditional PUT is a persistent one-attempt guard across fresh jobs/runners too.
        consume_provenance(request, proof, store, material.archive_key, directory)
        reviewed = {}
        for field, before in buckets.items():
            current = inspect_bucket(api, config['platform'][field])
            old_objects = [row for row in current['objects'] if field != 'outboxBucket' or row['key'] != cleanup_key(request)]
            require(current['identity'] == before['identity'] and old_objects == before['objects']
                    and len(current['objects']) == len(before['objects']) + int(field == 'outboxBucket'), 'EASYEMAIL_PREVIEW_TARGET_CHANGED')
            reviewed[field] = current
        require(source_state(config, api) == proof['state'], 'EASYEMAIL_PREVIEW_TARGET_CHANGED')
        for role, key in [('platform', 'target-3'), ('email', 'target-1')]:
            stop_ingress(config, role, api); statuses[key] = 'removed'
        checks.append({'id': 'preview-ingress-stopped', 'passed': True})
        for role, key in [('platform', 'target-2'), ('email', 'target-0')]:
            remove_worker(config, role, api); statuses[key] = 'removed'
        # A late foreign binding blocks data removal, even after the preview Workers were stopped.
        verify_unshared(config, api, workers_present=False)
        for role, key in [('platform', 'resource-platformDb'), ('email', 'resource-emailDb')]:
            remove_database(config, role, databases[role], api); statuses[key] = 'removed'
        for field, key, label in [('inboxBucket', 'resource-inbox', 'cleanup-inbox'), ('outboxBucket', 'resource-outbox', 'cleanup-outbox')]:
            remove_bucket(api, config['platform'][field], reviewed[field], label); statuses[key] = 'removed'
        for role in ('email', 'platform'):
            require(worker_absent(config, role, api) and database_absent(config, role, api), 'EASYEMAIL_PREVIEW_RESOURCE_CLEANUP_UNCONFIRMED')
        require(all(bucket_identity(api, config['platform'][field]) is None for field in ('inboxBucket', 'outboxBucket')),
                'EASYEMAIL_PREVIEW_RESOURCE_CLEANUP_UNCONFIRMED')
        checks.append({'id': 'preview-resources-removed', 'passed': True})
        return {'status': 'succeeded', 'checks': checks, 'lifecycle': {'resources': [{'key': key, 'status': value} for key, value in statuses.items()]}}
    except Exception as error:
        return {'status': 'unknown' if state.attempted else 'failed', 'checks': checks,
                **({'lifecycle': {'resources': [{'key': key, 'status': value} for key, value in statuses.items()]}} if state.attempted else {}),
                'errorCode': error.code if isinstance(error, DeploymentError) else 'EASYEMAIL_UNEXPECTED_FAILURE'}

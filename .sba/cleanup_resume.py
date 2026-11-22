"""Independent, journaled continuation of an already consumed preview cleanup; never replay its task."""
import os

from boundary import DeploymentError, require
from cloud_transport import CloudApi, OperationState
from cleanup_buckets import remove_bucket
from cleanup_evidence import load_evidence, validate_evidence
from cleanup_journal import claim, inherited_witness
from cleanup_references import verify_unshared
from cleanup_resources import remove_database, remove_worker
from cleanup_resume_state import observe, initial_witness, verify_remaining, all_absent
from configuration import preview_configuration
from deployment_secrets import deployment_secrets
from snapshot_bundle import private_directory


ERROR = 'EASYEMAIL_CLEANUP_RESUME_UNCONFIRMED'
RESOURCES = [('workers', 'platform', 'target-2'), ('workers', 'email', 'target-0'),
             ('databases', 'email', 'resource-emailDb'), ('buckets', 'inboxBucket', 'resource-inbox'),
             ('buckets', 'outboxBucket', 'resource-outbox'), ('databases', 'platform', 'resource-platformDb')]


def resume_cleanup(request, original, directory):
    config = request['configuration']; context = request['context']; progress = context['cleanupProgress']
    material = deployment_secrets(preview_configuration(config), {**os.environ, 'EE_PROVIDER_SECRETS': '{}'})
    state = OperationState(private_directory(directory), request['taskId']); checks = []
    statuses = {row['key']: 'unknown' for row in original['context']['resources']}
    def result(status, error=None):
        return {'status': status, 'checks': checks, 'lifecycle': {'resources': [{'key': key, 'status': value} for key, value in statuses.items()]},
                **({'errorCode': error} if error else {})}
    try:
        api = CloudApi(config['accountId'], material.token, state)
        current = observe(config, api)
        for role, key in [('email', 'target-1'), ('platform', 'target-3')]: statuses[key] = 'absent' if current['workers'][role] is None else 'removed'
        if current['databases']['platform'] is None:
            parent = progress['parentResult']; done = parent.get('lifecycle', {}).get('resources', [])
            require(progress['journalTaskId'] is not None and any(row['id'] == 'cleanup-resume-claim-persisted' and row['passed'] for row in parent['checks']) and
                    {row['key'] for row in done if row['status'] in ('removed', 'absent')} >= set(statuses) - {'resource-platformDb'} and all_absent(current), ERROR)
            for key in statuses: statuses[key] = 'absent'
            checks.extend({'id': name, 'passed': True} for name in ('preview-resources-removed', 'repair-completed'))
            return result('succeeded')
        witness, exists = inherited_witness(request, api, material.archive_key)
        if witness is None:
            proof, consumed = load_evidence(original, progress, api, material.archive_key, current['buckets'])
            witness = initial_witness(current, proof, consumed, progress, progress['parentResult'])
        else:
            validate_evidence(original, witness['proof'], witness['consumed'], progress)
        verify_remaining(current, witness)
        claim(request, witness, api, material.archive_key, exists)
        checks.append({'id': 'cleanup-resume-claim-persisted', 'passed': True})
        # No write begins until an exact, independently read-back claim is durable.
        for group, name, key in RESOURCES:
            current = observe(config, api); verify_remaining(current, witness)
            value = current[group][name]
            if value is None: statuses[key] = 'absent'; continue
            if group != 'workers': verify_unshared(config, api, workers_present=False)
            if group == 'workers': remove_worker(config, name, api)
            elif group == 'databases': remove_database(config, name, value, api)
            else: remove_bucket(api, config['platform'][name], value, 'cleanup-resume-' + ('inbox' if name == 'inboxBucket' else 'outbox'))
            statuses[key] = 'removed'
        require(all_absent(observe(config, api)), ERROR)
        checks.extend({'id': name, 'passed': True} for name in ('preview-resources-removed', 'repair-completed'))
        return result('succeeded')
    except Exception as error:
        return result('unknown' if state.attempted else 'failed', error.code if isinstance(error, DeploymentError) else 'EASYEMAIL_UNEXPECTED_FAILURE')

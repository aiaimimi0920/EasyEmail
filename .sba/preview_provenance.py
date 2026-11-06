"""Durable, authenticated private copy provenance; bind cleanup to the complete platform result."""
import hashlib
import hmac
import json
import os

from boundary import DeploymentError, digest, exact, matches, require
from contract import validate_context
from object_snapshot import PRIVATE_PREFIX
from private_files import secret_file
from snapshot_bundle import file_digest


RESULT_IDENTITY = ('schemaVersion', 'taskId', 'action', 'sourceSha', 'applicationVersion')


def persist_provenance(request, result, state, store, key, directory):
    full_result = {**{field: request[field] for field in RESULT_IDENTITY}, **result}
    payload = {'schemaVersion': 1, 'previewTaskId': request['taskId'], 'configurationDigest': digest(request['configuration']),
               'resources': request['context']['resources'], 'source': request['context']['source'],
               'state': state, 'result': full_result, 'resultDigest': digest(full_result)}
    signature = hmac.new(bytes.fromhex(key), digest(payload).encode('ascii'), hashlib.sha256).hexdigest()
    path = directory / 'preview-provenance.json'
    with secret_file(path) as output:
        json.dump({'payload': payload, 'signature': signature}, output, ensure_ascii=False)
        output.flush(); os.fsync(output.fileno())
    checksum = file_digest(path)
    metadata = {'size': path.stat().st_size, 'httpMetadata': {'contentType': 'application/json'},
                'customMetadata': {'format': 'easyemail-preview-v1', 'sha256': checksum}, 'storageClass': 'Standard'}
    row = store.upload('OUTBOX', PRIVATE_PREFIX + 'previews/' + request['taskId'] + '.json', path, metadata, checksum, 'preview-provenance-persisted')
    require(store.get('OUTBOX', row) == checksum, 'EASYEMAIL_PREVIEW_PROVENANCE_UNCONFIRMED')


def cleanup_key(request):
    return PRIVATE_PREFIX + 'cleanup/' + request['context']['previewTaskId'] + '.json'


def load_provenance(request, store, key, directory):
    error = 'EASYEMAIL_PREVIEW_PROVENANCE_INVALID'; context = request['context']
    rows = store.list('OUTBOX')
    require(all(row['key'] != cleanup_key(request) for row in rows), 'EASYEMAIL_PREVIEW_CLEANUP_ALREADY_ATTEMPTED')
    name = PRIVATE_PREFIX + 'previews/' + context['previewTaskId'] + '.json'
    selected = [row for row in rows if row['key'] == name]
    require(len(selected) == 1 and 0 < selected[0]['size'] <= 131072
            and selected[0]['customMetadata'].get('format') == 'easyemail-preview-v1'
            and matches(r'[a-f0-9]{64}', selected[0]['customMetadata'].get('sha256')), error)
    path = directory / 'provenance-download.json'; checksum = selected[0]['customMetadata']['sha256']
    require(store.get('OUTBOX', selected[0], path) == checksum and file_digest(path) == checksum, error)
    def unique(pairs):
        result = {}
        for name, value in pairs:
            require(name not in result, error); result[name] = value
        return result
    try: record = json.loads(path.read_text(encoding='utf8'), object_pairs_hook=unique)
    except (ValueError, UnicodeError): raise DeploymentError(error) from None
    exact(record, ['payload', 'signature']); payload = record['payload']
    require(isinstance(payload, dict) and matches(r'[a-f0-9]{64}', record['signature'])
            and hmac.compare_digest(record['signature'], hmac.new(bytes.fromhex(key), digest(payload).encode('ascii'), hashlib.sha256).hexdigest()), error)
    exact(payload, ['schemaVersion', 'previewTaskId', 'configurationDigest', 'resources', 'source', 'state', 'result', 'resultDigest'])
    result = payload['result']; exact(result, [*RESULT_IDENTITY, 'status', 'checks', 'lifecycle'])
    require(payload['schemaVersion'] == 1 and payload['previewTaskId'] == context['previewTaskId'] == context['instanceId']
            and payload['configurationDigest'] == digest(request['configuration']) and payload['resources'] == context['resources']
            and payload['resultDigest'] == context['resultDigest'] == digest(result), error)
    require(result['schemaVersion'] == request['schemaVersion'] and result['taskId'] == context['previewTaskId']
            and result['action'] == 'preview' and result['status'] == 'succeeded'
            and all(result[field] == request[field] for field in ('sourceSha', 'applicationVersion')), error)
    checks = result['checks']; lifecycle = result['lifecycle']; exact(lifecycle, ['resources', 'urls', 'snapshot'])
    require(isinstance(checks, list) and 4 <= len(checks) <= 30
            and all(isinstance(row, dict) and set(row) == {'id', 'passed'} and matches(r'[a-z][a-z0-9-]{1,62}', row['id'])
                    and row['passed'] is True for row in checks) and len({row['id'] for row in checks}) == len(checks), error)
    require({'snapshot-copied', 'migration-verified', 'source-unchanged', 'side-effects-isolated'} <= {row['id'] for row in checks}, error)
    require(lifecycle['resources'] == [{'key': row['key'], 'status': 'created'} for row in context['resources']], error)
    exact(lifecycle['snapshot'], ['id', 'createdAt'])
    require(matches(r'[a-f0-9]{64}', lifecycle['snapshot']['id']) and type(lifecycle['snapshot']['createdAt']) is int
            and 0 < lifecycle['snapshot']['createdAt'] <= 9007199254740991 and isinstance(payload['state'], dict), error)
    # Reuse the application boundary to reject signed-but-retargeted/shared resources too.
    validate_context({**request, 'action': 'preview', 'previous': {field: payload['source'][field] for field in ('sourceSha', 'applicationVersion')},
                      'context': {'source': payload['source'], 'resources': payload['resources'], 'urls': lifecycle['urls']}})
    return payload


def consume_provenance(request, payload, store, key, directory):
    name = cleanup_key(request)
    require(all(row['key'] != name for row in store.list('OUTBOX')), 'EASYEMAIL_PREVIEW_CLEANUP_ALREADY_ATTEMPTED')
    value = {'format': 'easyemail-preview-cleanup-v1', 'previewTaskId': payload['previewTaskId'], 'destroyTaskId': request['taskId'],
             'resultDigest': payload['resultDigest'], 'configurationDigest': payload['configurationDigest'], 'resources': payload['resources']}
    signature = hmac.new(bytes.fromhex(key), digest(value).encode('ascii'), hashlib.sha256).hexdigest()
    path = directory / 'cleanup-authority.json'
    with secret_file(path) as output:
        json.dump({'payload': value, 'signature': signature}, output); output.flush(); os.fsync(output.fileno())
    checksum = file_digest(path)
    row = store.upload('OUTBOX', name, path, {'size': path.stat().st_size, 'httpMetadata': {'contentType': 'application/json'},
                       'customMetadata': {'format': value['format'], 'sha256': checksum}, 'storageClass': 'Standard'}, checksum,
                       'preview-cleanup-authority-consumed')
    require(store.get('OUTBOX', row) == checksum, 'EASYEMAIL_PREVIEW_CLEANUP_AUTHORITY_UNCONFIRMED')
    return row

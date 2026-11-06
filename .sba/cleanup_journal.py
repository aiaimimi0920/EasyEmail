"""Immutable signed cleanup claims in the target platform D1; unique parent prevents sibling execution."""
import hashlib
import hmac
import json

from boundary import digest, require
from preview_provenance import signed_payload


ERROR = 'EASYEMAIL_CLEANUP_RESUME_JOURNAL_INVALID'
TABLE = 'easyemail_sba_cleanup_claims_v1'
CREATE = f'CREATE TABLE {TABLE} (task_id TEXT PRIMARY KEY, parent_task_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL)'


def table_exists(api, database):
    rows = api.query(database, "SELECT sql FROM sqlite_master WHERE name=?", [TABLE])
    require(rows == [] or rows == [{'sql': CREATE}], ERROR)
    return bool(rows)


def read_claim(api, database, task_id, key):
    rows = api.query(database, f'SELECT record FROM {TABLE} WHERE task_id=?', [task_id])
    require(len(rows) <= 1, ERROR)
    if not rows: return None
    require(set(rows[0]) == {'record'} and isinstance(rows[0]['record'], str)
            and len(rows[0]['record'].encode('utf8')) <= 524288, ERROR)
    value = signed_payload(rows[0]['record'].encode('utf8'), key)
    require(isinstance(value, dict) and value.get('taskId') == task_id, ERROR)
    return value


def inherited_witness(request, api, key):
    database = request['configuration']['platform']['database']['id']; context = request['context']
    progress = context['cleanupProgress']; exists = table_exists(api, database)
    if not exists:
        # No reconstruction after an unknown attempt to create a journal or after its loss.
        require(progress['journalTaskId'] is None and progress['consumedTaskId'] == context['parentTaskId'], ERROR)
        return None, False
    parent = read_claim(api, database, context['parentTaskId'], key)
    if parent is not None:
        require(parent.get('requestDigest') == context['requestDigest'], ERROR)
        selected = parent
    else:
        require(progress['journalTaskId'] is not None, ERROR)
        selected = read_claim(api, database, progress['journalTaskId'], key)
    require(selected is not None and set(selected) == {'format', 'taskId', 'parentTaskId', 'requestDigest',
        'consumedTaskId', 'permitAt', 'baselineDigest', 'configurationDigest', 'resources', 'witness'} and
        selected['format'] == 'easyemail-cleanup-resume-v1' and selected['consumedTaskId'] == progress['consumedTaskId'] and
        selected['permitAt'] == progress['permitAt'] and selected['baselineDigest'] == digest(context['cleanup']) and
        selected['configurationDigest'] == digest(request['configuration']) and
        selected['resources'] == context['cleanup']['context']['resources'], ERROR)
    return selected['witness'], True


def claim(request, witness, api, key, exists):
    database = request['configuration']['platform']['database']['id']; context = request['context']; progress = context['cleanupProgress']
    payload = {'format': 'easyemail-cleanup-resume-v1', 'taskId': request['taskId'], 'parentTaskId': context['parentTaskId'],
        'requestDigest': digest(request), 'consumedTaskId': progress['consumedTaskId'], 'permitAt': progress['permitAt'],
        'baselineDigest': digest(context['cleanup']), 'configurationDigest': digest(request['configuration']),
        'resources': context['cleanup']['context']['resources'], 'witness': witness}
    record = json.dumps({'payload': payload, 'signature': hmac.new(bytes.fromhex(key), digest(payload).encode('ascii'), hashlib.sha256).hexdigest()},
                        ensure_ascii=False, separators=(',', ':'))
    require(len(record.encode('utf8')) <= 524288, ERROR)
    insert = f'INSERT INTO {TABLE} (task_id,parent_task_id,record) VALUES (?,?,?)'
    # Separate statements reuse the existing single-result adapter. If only CREATE commits,
    # an empty journal deliberately stops the successor; it cannot masquerade as zero writes.
    if not exists: api.query(database, CREATE, write='cleanup-resume-table-created')
    api.query(database, insert, [request['taskId'], context['parentTaskId'], record], write='cleanup-resume-claim-written')
    require(table_exists(api, database) and read_claim(api, database, request['taskId'], key) == payload, ERROR)

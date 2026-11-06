"""Private preview R2 teardown: one reviewed, bounded object batch; no prefix jobs or clearing loops."""
import json
from datetime import datetime
from urllib.parse import urlencode

from boundary import matches, require


ERROR = 'EASYEMAIL_PREVIEW_BUCKET_CLEANUP_UNCONFIRMED'


def timestamp(value):
    require(isinstance(value, str) and len(value) <= 64, ERROR)
    try: parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError: require(False, ERROR)
    require(parsed.tzinfo is not None, ERROR)
    return value


def bucket_identity(api, name):
    body = api.request('GET', '/r2/buckets?' + urlencode({'per_page': 1000, 'name_contains': name}))
    result, info = body['result'], body.get('result_info', {})
    # R2 total_count is account-wide, not the number matching name_contains.
    require(isinstance(result, dict) and isinstance(result.get('buckets'), list) and len(result['buckets']) <= 1000
            and isinstance(info, dict) and not info.get('cursor'), ERROR)
    rows = result['buckets']
    require(all(isinstance(row, dict) and isinstance(row.get('name'), str) for row in rows)
            and len({row['name'] for row in rows}) == len(rows), ERROR)
    found = [row for row in rows if row['name'] == name]
    if not found: return None
    row = found[0]
    require(row.get('jurisdiction', 'default') in ('', 'default'), ERROR)
    return {'name': name, 'createdAt': timestamp(row.get('creation_date'))}


def private_bucket(api, name):
    prefix = '/r2/buckets/' + name
    locks, custom, managed = (api.get(prefix + suffix) for suffix in ('/lock', '/domains/custom', '/domains/managed'))
    require(isinstance(locks, dict) and locks.get('rules') == [] and isinstance(custom, dict) and custom.get('domains') == []
            and isinstance(managed, dict) and managed.get('enabled') is False, ERROR)
    value, status = api.read_response('/event_notifications/r2/' + name + '/configuration', statuses=(200, 404))
    require(isinstance(value, dict), ERROR)
    if status == 404:
        errors = value.get('errors')
        require(value.get('success') is False and value.get('result') is None and isinstance(errors, list)
                and len(errors) == 1 and isinstance(errors[0], dict) and errors[0].get('code') == 11015, ERROR)
    else:
        require(status == 200 and value.get('success') is True and value.get('errors') == []
                and isinstance(value.get('result'), dict) and value['result'].get('queues') == [], ERROR)


def bucket_objects(api, name):
    prefix = '/r2/buckets/' + name + '/objects'
    body = api.request('GET', prefix + '?per_page=1000'); rows = body['result']; info = body.get('result_info')
    require(isinstance(rows, list) and len(rows) <= 1000, ERROR)
    if info is not None:
        require(isinstance(info, dict) and info.get('is_truncated') is False and not info.get('cursor'), ERROR)
    selected = []
    for row in rows:
        require(isinstance(row, dict) and isinstance(row.get('key'), str) and 0 < len(row['key'].encode('utf8')) <= 1024
                and type(row.get('size')) is int and 0 <= row['size'] <= 9007199254740991
                and matches(r'[a-fA-F0-9]{32}(?:-\d+)?', row.get('etag')), ERROR)
        selected.append({'key': row['key'], 'size': row['size'], 'etag': row['etag'], 'modifiedAt': timestamp(row.get('last_modified'))})
    keys = [row['key'] for row in selected]
    require(keys == sorted(set(keys)) and sum(row['size'] for row in selected) <= 9007199254740991
            and len(json.dumps(keys, ensure_ascii=False, separators=(',', ':')).encode('utf8')) <= 262144, ERROR)
    if info is None and keys:
        tail = api.request('GET', prefix + '?' + urlencode({'per_page': 1, 'start_after': keys[-1]}))
        require(tail['result'] == [] and (tail.get('result_info') is None
                or isinstance(tail['result_info'], dict) and tail['result_info'].get('is_truncated') is False
                and not tail['result_info'].get('cursor')), ERROR)
    return selected


def inspect_bucket(api, name):
    identity = bucket_identity(api, name); require(identity is not None, ERROR)
    private_bucket(api, name)
    return {'identity': identity, 'objects': bucket_objects(api, name)}


def remove_bucket(api, name, expected, label):
    require(inspect_bucket(api, name) == expected, ERROR)
    keys = [row['key'] for row in expected['objects']]
    if keys:
        removed = api.request('DELETE', '/r2/buckets/' + name + '/objects', keys, write=label + '-objects-deleted')['result']
        require(isinstance(removed, list) and len(removed) == len(keys) and all(isinstance(row, dict) and set(row) == {'key'} for row in removed)
                and sorted(row['key'] for row in removed) == keys, ERROR)
    require(bucket_objects(api, name) == [] and bucket_identity(api, name) == expected['identity'], ERROR)
    api.delete('/r2/buckets/' + name, write=label + '-bucket-deleted')
    require(bucket_identity(api, name) is None, ERROR)

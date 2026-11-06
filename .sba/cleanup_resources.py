"""Preview HTTP exposure and exact Worker/D1 identities; all DELETE acknowledgments require independent absence."""
import time

from boundary import matches, require
from cleanup_buckets import timestamp
from cleanup_references import listed


ERROR = 'EASYEMAIL_PREVIEW_RESOURCE_CLEANUP_UNCONFIRMED'


def database_identity(config, role, api):
    expected = config[role]['database']; row = api.get('/d1/database/' + expected['id'])
    require(isinstance(row, dict) and row.get('uuid') == expected['id'] and row.get('name') == expected['name'], ERROR)
    return {'id': row['uuid'], 'name': row['name'], 'createdAt': timestamp(row.get('created_at'))}


def worker_absent(config, role, api):
    rows = listed(api, '/workers/scripts', limit=100)
    require(all(isinstance(row, dict) and matches(r'[a-z0-9][a-z0-9_-]{0,62}', row.get('id')) for row in rows)
            and len({row['id'] for row in rows}) == len(rows), ERROR)
    return all(row['id'] != config[role]['name'] for row in rows)


def database_absent(config, role, api):
    expected = config[role]['database']
    body, status = api.read_response('/d1/database/' + expected['id'], statuses=(200, 404))
    require(isinstance(body, dict), ERROR)
    if status == 404:
        errors = body.get('errors')
        require(body.get('success') is False and 'result' in body and body['result'] is None and
                isinstance(errors, list) and len(errors) == 1 and isinstance(errors[0], dict) and errors[0].get('code') == 7404, ERROR)
        return True
    row = body.get('result')
    require(status == 200 and body.get('success') is True and body.get('errors') == [] and isinstance(row, dict) and
            row.get('uuid') == expected['id'] and row.get('name') == expected['name'], ERROR)
    return False


def stop_ingress(config, role, api):
    path = '/workers/scripts/' + config[role]['name'] + '/subdomain'
    expected = {'enabled': False, 'previews_enabled': False}
    result = api.request('POST', path, expected, write='cleanup-' + role + '-ingress-stopped')['result']
    for value in (result, api.get(path)):
        require(isinstance(value, dict) and all(value.get(key) is item for key, item in expected.items()), ERROR)


def remove_worker(config, role, api):
    exposure = api.get('/workers/scripts/' + config[role]['name'] + '/subdomain')
    require(isinstance(exposure, dict) and exposure.get('enabled') is False and exposure.get('previews_enabled') is False, ERROR)
    api.delete('/workers/scripts/' + config[role]['name'], write='cleanup-' + role + '-worker-deleted')
    # A successful DELETE can precede list visibility. Retry only valid GET
    # observations, never DELETE or transport/authentication/malformed-list errors.
    for delay in (0, 1, 2, 4, 8):
        if delay: time.sleep(delay)
        if worker_absent(config, role, api): return
    require(False, ERROR)


def remove_database(config, role, expected, api):
    require(database_identity(config, role, api) == expected, ERROR)
    api.delete('/d1/database/' + expected['id'], write='cleanup-' + role + '-database-deleted')
    # Observe the immutable UUID directly, not an account-wide list/count after a deletion.
    for delay in (0, 1, 2, 4, 8):
        if delay: time.sleep(delay)
        if database_absent(config, role, api): return
    require(False, ERROR)

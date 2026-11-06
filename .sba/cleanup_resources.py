"""Preview HTTP exposure and exact Worker/D1 identities; all DELETE acknowledgments require independent absence."""
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
    rows = listed(api, '/d1/database?per_page=1000&page=1')
    require(all(isinstance(row, dict) and matches(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', row.get('uuid')) for row in rows)
            and len({row['uuid'] for row in rows}) == len(rows), ERROR)
    return all(row['uuid'] != config[role]['database']['id'] for row in rows)


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
    require(worker_absent(config, role, api), ERROR)


def remove_database(config, role, expected, api):
    require(database_identity(config, role, api) == expected, ERROR)
    api.delete('/d1/database/' + expected['id'], write='cleanup-' + role + '-database-deleted')
    require(database_absent(config, role, api), ERROR)

"""Identity/private-access gates shared by fresh deployment and same-instance upgrades."""
from boundary import digest, require


def data_identity(config, api, *, require_empty):
    identities = []
    for role in ('email', 'platform'):
        database = config[role]['database']
        row = api.get('/d1/database/' + database['id'])
        require(isinstance(row, dict) and row.get('uuid') == database['id'] and row.get('name') == database['name']
                and isinstance(row.get('created_at'), str) and row['created_at'], 'EASYEMAIL_RESOURCE_MISMATCH')
        identities.append({'kind': 'd1', 'id': database['id'], 'createdAt': row['created_at']})
        if require_empty:
            tables = api.query(database['id'], "SELECT type,name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name!='_cf_KV' ORDER BY name")
            require(tables == [], 'EASYEMAIL_RESOURCE_NOT_EMPTY')
    for field in ('inboxBucket', 'outboxBucket'):
        bucket = config['platform'][field]; path = '/r2/buckets/' + bucket
        row = api.get(path)
        require(isinstance(row, dict) and row.get('name') == bucket and isinstance(row.get('creation_date'), str)
                and row['creation_date'] and row.get('jurisdiction', 'default') in ('default', ''), 'EASYEMAIL_RESOURCE_MISMATCH')
        identities.append({'kind': 'r2', 'id': bucket, 'createdAt': row['creation_date']})
        managed, custom = api.get(path + '/domains/managed'), api.get(path + '/domains/custom')
        require(isinstance(managed, dict) and managed.get('enabled') is False
                and isinstance(custom, dict) and custom.get('domains') == [], 'EASYEMAIL_BUCKET_NOT_PRIVATE')
        if require_empty:
            objects = api.request('GET', path + '/objects?per_page=1')
            info = objects.get('result_info', {})
            require(objects['result'] == [] and isinstance(info, dict) and not info.get('is_truncated')
                    and not info.get('cursor'), 'EASYEMAIL_RESOURCE_NOT_EMPTY')
    return digest(identities)

"""Current resource identities and immutable witness checks for the approved partial cleanup."""
from datetime import datetime

from boundary import digest, exact, require
from cleanup_buckets import bucket_identity, inspect_bucket, timestamp
from cleanup_resources import database_absent, database_identity
from cleanup_references import listed, verify_unshared


ERROR = 'EASYEMAIL_CLEANUP_RESUME_TARGET_CHANGED'
ROLES = ('email', 'platform')
FIELDS = ('inboxBucket', 'outboxBucket')


def observe(config, api):
    workers = listed(api, '/workers/scripts', limit=100)
    require(all(isinstance(row, dict) and isinstance(row.get('id'), str) for row in workers) and
            len({row['id'] for row in workers}) == len(workers), ERROR)
    result = {'workers': {}, 'databases': {}, 'buckets': {}}
    for role in ROLES:
        name = config[role]['name']; rows = [row for row in workers if row['id'] == name]
        identity = None
        if rows:
            path = '/workers/scripts/' + name; settings = api.get(path + '/settings'); schedules = api.get(path + '/schedules')
            require(isinstance(settings, dict) and isinstance(settings.get('bindings'), list) and schedules == {'schedules': []}, ERROR)
            bindings = settings['bindings']; expected = {'DB': ('d1', 'id', config[role]['database']['id'])}
            if role == 'platform': expected.update({key: ('r2_bucket', 'bucket_name', config['platform'][field]) for key, field in [('INBOX', FIELDS[0]), ('OUTBOX', FIELDS[1])]})
            require(all(isinstance(row, dict) and isinstance(row.get('name'), str) and isinstance(row.get('type'), str) for row in bindings) and
                    len({row['name'] for row in bindings}) == len(bindings), ERROR)
            selected = {row['name']: row for row in bindings}
            for key, (kind, field, value) in expected.items():
                require(key in selected and selected[key].get('type') == kind and selected[key].get(field) == value, ERROR)
            require(all(row['type'] in ('plain_text', 'secret_text', 'json') or row['name'] in expected for row in bindings), ERROR)
            exposure = api.get(path + '/subdomain')
            require(isinstance(exposure, dict) and exposure.get('enabled') is False and exposure.get('previews_enabled') is False, ERROR)
            identity = {'createdAt': timestamp(rows[0].get('created_on')), 'settingsDigest': digest({'settings': settings, 'schedules': schedules})}
        result['workers'][role] = identity
        result['databases'][role] = None if database_absent(config, role, api) else database_identity(config, role, api)
    for field in FIELDS:
        name = config['platform'][field]
        result['buckets'][field] = None if bucket_identity(api, name) is None else inspect_bucket(api, name)
    verify_unshared(config, api, live_roles={role for role, value in result['workers'].items() if value is not None})
    return result


def initial_witness(current, proof, consumed, progress, parent_result):
    require({'preview-authority-verified', 'preview-ingress-stopped'} <=
            {row['id'] for row in parent_result['checks'] if row['passed']}, ERROR)
    require(all(value is not None for value in (*current['databases'].values(), *current['buckets'].values())), ERROR)
    identities = [{'kind': 'd1', 'id': current['databases'][role]['id'], 'createdAt': current['databases'][role]['createdAt']} for role in ROLES]
    identities += [{'kind': 'r2', 'id': current['buckets'][field]['identity']['name'], 'createdAt': current['buckets'][field]['identity']['createdAt']} for field in FIELDS]
    require(proof['state']['managed'] == {'resources': digest(identities), 'domains': {}, 'routing': None}, ERROR)
    for value in current['workers'].values():
        if value is not None:
            # This uses the original completed run's historical state verification; it does not
            # claim to reconstruct its now-unavailable aggregate Worker settings digest.
            created = datetime.fromisoformat(value['createdAt'].replace('Z', '+00:00')).timestamp() * 1000
            require(created <= progress['permitAt'], ERROR)
    return {**current, 'proof': proof, 'consumed': consumed}


def verify_remaining(current, witness):
    exact(witness, ['workers', 'databases', 'buckets', 'proof', 'consumed'])
    for group, keys in [('workers', ROLES), ('databases', ROLES)]:
        exact(witness[group], keys)
        for key in keys:
            value = current[group][key]
            require(value is None or value == witness[group][key], ERROR)
    exact(witness['buckets'], FIELDS)
    for field in FIELDS:
        value, old = current['buckets'][field], witness['buckets'][field]
        require(old is not None, ERROR)
        if value is not None:
            require(value['identity'] == old['identity'] and all(row in old['objects'] for row in value['objects']), ERROR)


def all_absent(current):
    return all(value is None for group in current.values() for value in group.values())

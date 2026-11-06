"""Bounded account metadata checks: approved preview data/Workers must not be shared or acquire other ingress."""
from boundary import matches, require
from production_domains import listed_domains, zone_identity


ERROR = 'EASYEMAIL_PREVIEW_CLEANUP_SHARED_OR_UNVERIFIED'


def listed(api, path, *, zone=None, limit=1000):
    body = api.request('GET', path, zone=zone)
    rows, info = body['result'], body.get('result_info')
    require(isinstance(rows, list) and len(rows) <= limit, ERROR)
    if info is not None:
        require(isinstance(info, dict) and info.get('is_truncated', False) is False and not info.get('cursor')
                and type(info.get('total_pages', 1)) is int and info.get('total_pages', 1) <= 1
                and type(info.get('total_count', len(rows))) is int and info.get('total_count', len(rows)) == len(rows), ERROR)
    return rows


def binding_identity(row):
    kind = row.get('type')
    if kind == 'd1': return ('d1', row.get('id'))
    if kind == 'r2_bucket':
        jurisdiction = row.get('jurisdiction', 'default')
        require(isinstance(jurisdiction, str), ERROR)
        return ('r2_bucket' if jurisdiction in ('default', '') else 'r2-' + jurisdiction, row.get('bucket_name'))
    if kind in ('kv_namespace', 'durable_object_namespace'): return (kind, row.get('namespace_id'))
    return None


def verify_email_unreferenced(config, api):
    targets = {config[role]['name'] for role in ('email', 'platform')}; rows = []; total = None
    for page in range(1, 21):
        body = api.request('GET', f'/email/routing/rules?per_page=50&page={page}')
        current, info = body['result'], body.get('result_info')
        require(isinstance(current, list) and len(current) <= 50 and isinstance(info, dict)
                and info.get('page') == page and type(info.get('count')) is int and info['count'] == len(current)
                and type(info.get('total_count')) is int and 0 <= info['total_count'] <= 1000, ERROR)
        if total is None: total = info['total_count']
        require(total == info['total_count'] and (current or total == 0), ERROR)
        rows += current; require(len(rows) <= total, ERROR)
        if len(rows) == total: break
    require(len(rows) == total and all(isinstance(row, dict) and isinstance(row.get('id'), str) for row in rows)
            and len({row['id'] for row in rows}) == len(rows), ERROR)
    for row in rows:
        actions = row.get('actions')
        require(isinstance(actions, list) and len(actions) == 1 and isinstance(actions[0], dict)
                and actions[0].get('type') in ('worker', 'forward', 'drop'), ERROR)
        if actions[0]['type'] == 'worker':
            value = actions[0].get('value')
            require(isinstance(value, list) and len(value) == 1 and isinstance(value[0], str) and value[0] not in targets, ERROR)


def verify_pages_unshared(config, api):
    workers = {config[role]['name'] for role in ('email', 'platform')}
    identities = {'d1_databases': {config[role]['database']['id'] for role in ('email', 'platform')},
                  'r2_buckets': {config['platform'][field] for field in ('inboxBucket', 'outboxBucket')},
                  'services': workers, 'durable_object_namespaces': workers}
    identity_fields = {'d1_databases': 'id', 'r2_buckets': 'name', 'services': 'service', 'durable_object_namespaces': 'service'}
    for project in listed(api, '/pages/projects?page=1'):
        require(isinstance(project, dict) and matches(r'[a-z0-9][a-z0-9_-]{0,62}', project.get('name'))
                and isinstance(project.get('deployment_configs'), dict), ERROR)
        deployments = listed(api, '/pages/projects/' + project['name'] + '/deployments?page=1')
        for deployment in deployments:
            # Pages omits unset binding maps even for an explicit Functions deployment.
            # Unknown Functions metadata is still a blocker; present maps are checked below.
            require(isinstance(deployment, dict) and type(deployment.get('uses_functions')) is bool, ERROR)
        for value in [*project['deployment_configs'].values(), *deployments]:
            require(isinstance(value, dict), ERROR)
            for field, selected in identities.items():
                bindings = value.get(field, {}); require(isinstance(bindings, dict), ERROR)
                for binding in bindings.values():
                    identity = binding.get(identity_fields[field]) if isinstance(binding, dict) else None
                    require(isinstance(identity, str) and identity not in selected, ERROR)


def verify_unshared(config, api, *, workers_present=True):
    selected = {config[role]['name'] for role in ('email', 'platform')}
    storage = {('d1', config[role]['database']['id']) for role in ('email', 'platform')}
    storage |= {('r2_bucket', config['platform'][field]) for field in ('inboxBucket', 'outboxBucket')}
    workers = listed(api, '/workers/scripts', limit=100)
    require(all(isinstance(row, dict) and matches(r'[a-z0-9][a-z0-9_-]{0,62}', row.get('id')) for row in workers)
            and len({row['id'] for row in workers}) == len(workers), ERROR)
    live = {row['id'] for row in workers}
    require(selected <= live if workers_present else not selected & live, ERROR)
    for worker in workers:
        value = api.get('/workers/scripts/' + worker['id'] + '/settings')
        require(isinstance(value, dict) and isinstance(value.get('bindings'), list) and len(value['bindings']) <= 128, ERROR)
        for binding in value['bindings']:
            require(isinstance(binding, dict) and isinstance(binding.get('type'), str), ERROR)
            identity = binding_identity(binding)
            if worker['id'] in selected:
                require(identity is None or identity in storage, ERROR)
                require(binding['type'] != 'service', ERROR)
            else:
                require(identity not in storage and not (binding['type'] == 'service' and binding.get('service') in selected)
                        and not (binding['type'] == 'durable_object_namespace' and binding.get('script_name') in selected), ERROR)
    verify_pages_unshared(config, api); verify_email_unreferenced(config, api)
    for role in ('email', 'platform'): require(listed_domains(api, {'service': config[role]['name']}) == [], ERROR)
    for zone in api.account_zones():
        identity = zone_identity(zone, config['accountId'])
        for route in listed(api, '/workers/routes', zone=identity['zoneId']):
            require(isinstance(route, dict) and route.get('script') not in selected, ERROR)

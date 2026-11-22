"""Read-only ownership witnesses for an already deployed, explicitly selected instance."""
from boundary import digest, require
from data_resources import data_identity
from email_routing import read_routing
from production_domains import listed_domains, resolved_domains, verify_workers_dev


def managed_state(config, api):
    verify_workers_dev(config, api)
    workers = api.get('/workers/scripts')
    require(isinstance(workers, list) and len(workers) <= 1000
            and all(isinstance(row, dict) and isinstance(row.get('id'), str) for row in workers)
            and len({row['id'] for row in workers}) == len(workers)
            and {config[role]['name'] for role in ('email', 'platform')} <= {row['id'] for row in workers},
            'EASYEMAIL_RESOURCE_MISMATCH')
    domains = resolved_domains(config, api)
    for role, selected in domains.items():
        rows = listed_domains(api, {'hostname': selected['hostname']})
        require(len(rows) == 1 and isinstance(rows[0], dict), 'EASYEMAIL_DOMAIN_READBACK_FAILED')
        row = rows[0]
        require(row.get('hostname') == selected['hostname'] and row.get('zone_id') == selected['zoneId']
                and row.get('zone_name') == selected['zoneName'] and row.get('service') == config[role]['name']
                and row.get('environment') == 'production' and row.get('enabled') is True and row.get('previews_enabled') is False,
                'EASYEMAIL_DOMAIN_READBACK_FAILED')
    routing = None
    if config['routing'] is not None:
        row = read_routing(config, api)
        require(row['enabled'] is True and row['actions'] == [{'type': 'worker', 'value': [config['email']['name']]}],
                'EASYEMAIL_EMAIL_ROUTE_CHANGED')
        routing = digest(row)
    return {'resources': data_identity(config, api, require_empty=False), 'domains': domains, 'routing': routing}

"""Resolve only owned Zones and refuse to replace existing DNS or Worker domains."""
from urllib.parse import urlencode, urlparse

from boundary import matches, origin, require
from configuration import isolated


def verify_workers_dev(config, api):
    if not isolated(config): return
    account = api.get('/workers/subdomain')
    require(isinstance(account, dict) and isinstance(account.get('subdomain'), str), 'EASYEMAIL_RESOURCE_MISMATCH')
    for role in ('email', 'platform'):
        component = config[role]
        require(urlparse(component['origin']).hostname == component['name'] + '.' + account['subdomain'] + '.workers.dev',
                'EASYEMAIL_RESOURCE_MISMATCH')


def zone_identity(value, account):
    require(isinstance(value, dict) and matches(r'[a-f0-9]{32}', value.get('id'))
            and isinstance(value.get('account'), dict) and value['account'].get('id') == account
            and value.get('status') == 'active', 'EASYEMAIL_DOMAIN_ZONE_MISMATCH')
    origin('https://' + value.get('name', ''))
    return {'zoneId': value['id'], 'zoneName': value['name']}


def listed_domains(api, filters):
    body = api.request('GET', '/workers/domains?' + urlencode(filters))
    rows, info = body['result'], body.get('result_info')
    # This endpoint reports filtered totals, but has no public pagination parameters or total_pages guarantee.
    require(isinstance(rows, list) and len(rows) <= 1000 and isinstance(info, dict)
            and type(info.get('page')) is int and info['page'] == 1
            and type(info.get('count')) is int and info['count'] == len(rows)
            and type(info.get('total_count')) is int and info['total_count'] == len(rows), 'EASYEMAIL_DOMAIN_LIST_INCOMPLETE')
    return rows


def recheck_domain(config, role, api, selected):
    if selected is None:
        require(isolated(config), 'EASYEMAIL_DOMAIN_ZONE_MISMATCH')
        return
    hostname = urlparse(config[role]['origin']).hostname
    require(selected['hostname'] == hostname, 'EASYEMAIL_DOMAIN_ZONE_MISMATCH')
    current = zone_identity(api.get('', zone=selected['zoneId']), config['accountId'])
    require(current == {key: selected[key] for key in ('zoneId', 'zoneName')}
            and (hostname == current['zoneName'] or hostname.endswith('.' + current['zoneName'])), 'EASYEMAIL_DOMAIN_ZONE_MISMATCH')
    dns = api.request('GET', '/dns_records?' + urlencode({'name': hostname, 'per_page': 5}), zone=selected['zoneId'])
    require(dns['result'] == [] and isinstance(dns.get('result_info'), dict)
            and type(dns['result_info'].get('total_count')) is int and dns['result_info']['total_count'] == 0,
            'EASYEMAIL_DOMAIN_DNS_NOT_EMPTY')
    require(listed_domains(api, {'hostname': hostname}) == [], 'EASYEMAIL_DOMAIN_ALREADY_USED')


def resolved_domains(config, api):
    if isolated(config):
        return {}
    zones = [zone_identity(row, config['accountId']) for row in api.account_zones()]
    result = {}
    for role in ('email', 'platform'):
        hostname = urlparse(config[role]['origin']).hostname
        candidates = [row for row in zones if hostname == row['zoneName'] or hostname.endswith('.' + row['zoneName'])]
        require(candidates, 'EASYEMAIL_DOMAIN_ZONE_NOT_FOUND')
        candidates.sort(key=lambda row: len(row['zoneName']), reverse=True)
        require(len(candidates) == 1 or len(candidates[0]['zoneName']) != len(candidates[1]['zoneName']), 'EASYEMAIL_DOMAIN_ZONE_MISMATCH')
        selected = {**candidates[0], 'hostname': hostname}
        result[role] = selected
    return result


def free_domains(config, api):
    result = resolved_domains(config, api)
    for role, selected in result.items(): recheck_domain(config, role, api, selected)
    return result

"""Independently read back deployed bindings, schedules, exposure and declared HTTP domains."""
import json

from boundary import digest, require
from configuration import isolated
from production_domains import listed_domains


def verify_settings(config, api, release, workers, domains=None):
    for role in ('email', 'platform'):
        expected = json.loads((release / 'publish' / role / 'wrangler.json').read_text(encoding='utf8'))
        path = '/workers/scripts/' + config[role]['name']
        actual = api.get(path + '/settings')
        require(isinstance(actual, dict) and actual.get('compatibility_date') == expected['compatibility_date']
                and sorted(actual.get('compatibility_flags', [])) == sorted(expected['compatibility_flags'])
                and actual.get('tail_consumers', []) == [], 'EASYEMAIL_PUBLISHED_SETTINGS_MISMATCH')
        rows = actual.get('bindings')
        require(isinstance(rows, list) and all(isinstance(row, dict) and isinstance(row.get('name'), str) for row in rows),
                'EASYEMAIL_PUBLISHED_SETTINGS_MISMATCH')
        bindings = {row['name']: row for row in rows}
        names = set(expected['vars']) | set(workers[role]) | {'DB'}
        sends = expected.get('send_email', [])
        names |= {row['name'] for row in sends}
        if role == 'platform': names |= {'INBOX', 'OUTBOX', 'ASSETS'}
        require(len(bindings) == len(rows) and set(bindings) == names, 'EASYEMAIL_PUBLISHED_SETTINGS_MISMATCH')
        for name, value in expected['vars'].items():
            row = bindings[name]
            kind, key = ('plain_text', 'text') if isinstance(value, str) else ('json', 'json')
            require(row.get('type') == kind and key in row and digest(row[key]) == digest(value), 'EASYEMAIL_PUBLISHED_SETTINGS_MISMATCH')
        for name in workers[role]:
            require(bindings[name].get('type') == 'secret_text', 'EASYEMAIL_PUBLISHED_SETTINGS_MISMATCH')
        for send in sends:
            row = bindings[send['name']]
            require(row.get('type') == 'send_email' and set(row) == {'name', 'type', 'allowed_destination_addresses'}
                    and isinstance(row.get('allowed_destination_addresses'), list)
                    and sorted(row['allowed_destination_addresses']) == sorted(send['allowed_destination_addresses']),
                    'EASYEMAIL_PUBLISHED_SETTINGS_MISMATCH')
        database = config[role]['database']['id']; row = bindings['DB']
        require(row.get('type') == 'd1' and row.get('id') == database and row.get('database_id', database) == database,
                'EASYEMAIL_PUBLISHED_SETTINGS_MISMATCH')
        if role == 'platform':
            require(bindings['ASSETS'].get('type') == 'assets', 'EASYEMAIL_PUBLISHED_SETTINGS_MISMATCH')
            for name, field in [('INBOX', 'inboxBucket'), ('OUTBOX', 'outboxBucket')]:
                row = bindings[name]
                require(row.get('type') == 'r2_bucket' and row.get('bucket_name') == config['platform'][field]
                        and row.get('jurisdiction', 'default') in ('default', ''), 'EASYEMAIL_PUBLISHED_SETTINGS_MISMATCH')
        schedules = api.get(path + '/schedules')
        require(isinstance(schedules, dict) and isinstance(schedules.get('schedules'), list)
                and all(isinstance(row, dict) and isinstance(row.get('cron'), str) for row in schedules['schedules'])
                and sorted(row['cron'] for row in schedules['schedules']) == sorted(expected['triggers']['crons']),
                'EASYEMAIL_SCHEDULE_READBACK_FAILED')
        exposure = api.get(path + '/subdomain')
        require(isinstance(exposure, dict) and exposure.get('enabled') is expected['workers_dev']
                and exposure.get('previews_enabled') is False, 'EASYEMAIL_EXPOSURE_READBACK_FAILED')
        actual_domains = listed_domains(api, {'service': config[role]['name']})
        if isolated(config):
            require(actual_domains == [], 'EASYEMAIL_ISOLATION_READBACK_FAILED')
        else:
            require(isinstance(domains, dict) and role in domains and isinstance(actual_domains, list) and len(actual_domains) == 1,
                    'EASYEMAIL_DOMAIN_READBACK_FAILED')
            row, selected = actual_domains[0], domains[role]
            require(isinstance(row, dict) and row.get('hostname') == selected['hostname'] and row.get('zone_id') == selected['zoneId']
                    and row.get('zone_name') == selected['zoneName'] and row.get('service') == config[role]['name']
                    and row.get('environment') == 'production' and row.get('enabled') is True and row.get('previews_enabled') is False,
                    'EASYEMAIL_DOMAIN_READBACK_FAILED')

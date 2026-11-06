import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from published_settings import verify_settings
from fixtures import configuration
from test_production_targets import production_configuration


SCRATCH = Path(os.environ.get('EASYEMAIL_TEST_ROOT', tempfile.gettempdir()))


class SettingsApi:
    def __init__(self): self.rows = {}; self.domain_info = {}
    def get(self, path): return copy.deepcopy(self.rows[path])

    def request(self, method, path):
        assert method == 'GET' and path.startswith('/workers/domains?')
        rows = self.get(path)
        info = self.domain_info.get(path, {'page': 1, 'count': len(rows), 'total_count': len(rows), 'per_page': len(rows)})
        return {'result': rows, 'result_info': copy.deepcopy(info)}


class PublishedSettingsTests(unittest.TestCase):
    def fixture(self, production=False):
        config = production_configuration() if production else configuration()
        root = Path(tempfile.mkdtemp(prefix='sba-settings-', dir=SCRATCH)); api = SettingsApi(); domains = {}
        workers = {'email': {'JWT_SECRET': 'synthetic'}, 'platform': {'MAILBOX_KEYRING': 'synthetic'}}
        for role in ('email', 'platform'):
            directory = root / 'publish' / role; directory.mkdir(parents=True)
            expected = {'vars': {'ORIGIN': config[role]['origin'], 'DISABLED': False, 'DOMAINS': [config['mailDomain']]},
                        'compatibility_date': '2026-10-23', 'compatibility_flags': ['nodejs_compat'],
                        'workers_dev': not production, 'triggers': {'crons': ['0 0 * * *'] if production else []}}
            if production and role == 'email':
                expected['send_email'] = [{'name': 'SEND_MAIL', 'allowed_destination_addresses': ['synthetic@example.com']}]
            (directory / 'wrangler.json').write_text(json.dumps(expected), encoding='utf8')
            rows = [{'name': name, 'type': 'plain_text' if isinstance(value, str) else 'json',
                     'text' if isinstance(value, str) else 'json': value} for name, value in expected['vars'].items()]
            rows += [{'name': name, 'type': 'secret_text'} for name in workers[role]]
            rows += [{'type': 'send_email', **row} for row in expected.get('send_email', [])]
            rows += [{'name': 'DB', 'type': 'd1', 'id': config[role]['database']['id'], 'database_id': config[role]['database']['id']}]
            if role == 'platform':
                rows += [{'name': name, 'type': 'r2_bucket', 'bucket_name': config['platform'][field]}
                         for name, field in [('INBOX', 'inboxBucket'), ('OUTBOX', 'outboxBucket')]]
                rows += [{'name': 'ASSETS', 'type': 'assets'}]
            path = '/workers/scripts/' + config[role]['name']
            api.rows[path + '/settings'] = {**expected, 'bindings': rows, 'tail_consumers': []}
            api.rows[path + '/schedules'] = {'schedules': [{'cron': cron} for cron in expected['triggers']['crons']]}
            api.rows[path + '/subdomain'] = {'enabled': not production, 'previews_enabled': False}
            domains[role] = {'hostname': config[role]['origin'][8:], 'zoneId': 'b' * 32, 'zoneName': 'example.com'}
            api.rows['/workers/domains?service=' + config[role]['name']] = ([{
                'hostname': domains[role]['hostname'], 'zone_id': 'b' * 32, 'zone_name': 'example.com',
                'service': config[role]['name'], 'environment': 'production', 'enabled': True, 'previews_enabled': False,
            }] if production else [])
        return config, root, api, workers, domains

    def test_exact_bindings_and_disabled_side_effects_read_back(self):
        verify_settings(*self.arguments(self.fixture()))

    def arguments(self, fixture):
        config, root, api, workers, domains = fixture
        return config, api, root, workers, domains

    def test_wrong_binding_duplicate_variable_or_numeric_boolean_is_rejected(self):
        for change in ('database', 'duplicate', 'boolean', 'extra-binding'):
            fixture = self.fixture(); config, root, api, workers, domains = fixture
            rows = api.rows['/workers/scripts/' + config['email']['name'] + '/settings']['bindings']
            if change == 'database': next(row for row in rows if row['name'] == 'DB')['id'] = 'foreign'
            if change == 'duplicate': rows.append(copy.deepcopy(rows[0]))
            if change == 'boolean': next(row for row in rows if row['name'] == 'DISABLED')['json'] = 0
            if change == 'extra-binding': rows.append({'name': 'SEND_MAIL', 'type': 'send_email'})
            with self.subTest(change=change), self.assertRaises(DeploymentError):
                verify_settings(*self.arguments(fixture))

    def test_cron_preview_or_custom_domain_prevents_isolation_success(self):
        for change in ('cron', 'preview', 'domain'):
            fixture = self.fixture(); config, root, api, workers, domains = fixture
            path = '/workers/scripts/' + config['email']['name']
            if change == 'cron': api.rows[path + '/schedules']['schedules'] = [{'cron': '* * * * *'}]
            if change == 'preview': api.rows[path + '/subdomain']['previews_enabled'] = True
            if change == 'domain': api.rows['/workers/domains?service=' + config['email']['name']] = [{'hostname': 'mail.example.com'}]
            with self.subTest(change=change), self.assertRaises(DeploymentError):
                verify_settings(*self.arguments(fixture))

    def test_formal_declared_domains_crons_and_restricted_send_binding_read_back(self):
        verify_settings(*self.arguments(self.fixture(production=True)))

    def test_formal_send_permission_cannot_expand_or_lose_declared_recipient(self):
        for change in ('recipient', 'unrestricted', 'extra-field'):
            fixture = self.fixture(production=True); config, root, api, workers, domains = fixture
            rows = api.rows['/workers/scripts/' + config['email']['name'] + '/settings']['bindings']
            binding = next(row for row in rows if row['name'] == 'SEND_MAIL')
            if change == 'recipient': binding['allowed_destination_addresses'] = ['foreign@example.com']
            if change == 'unrestricted': del binding['allowed_destination_addresses']
            if change == 'extra-field': binding['destination_address'] = 'foreign@example.com'
            with self.subTest(change=change), self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_PUBLISHED_SETTINGS_MISMATCH'):
                verify_settings(*self.arguments(fixture))

    def test_formal_exposure_schedule_or_domain_drift_cannot_pass_readback(self):
        for change in ('workers-dev', 'preview', 'cron', 'extra-cron', 'missing-domain', 'extra-domain',
                       'hostname', 'zone_id', 'zone_name', 'service', 'environment', 'enabled', 'previews_enabled'):
            fixture = self.fixture(production=True); config, root, api, workers, domains = fixture
            path = '/workers/scripts/' + config['email']['name']
            rows = api.rows['/workers/domains?service=' + config['email']['name']]
            if change == 'workers-dev': api.rows[path + '/subdomain']['enabled'] = True
            elif change == 'preview': api.rows[path + '/subdomain']['previews_enabled'] = True
            elif change == 'cron': api.rows[path + '/schedules']['schedules'] = []
            elif change == 'extra-cron': api.rows[path + '/schedules']['schedules'].append({'cron': '* * * * *'})
            elif change == 'missing-domain': rows.clear()
            elif change == 'extra-domain': rows.append(copy.deepcopy(rows[0]))
            else: rows[0][change] = not rows[0][change] if type(rows[0][change]) is bool else 'foreign'
            with self.subTest(change=change), self.assertRaises(DeploymentError):
                verify_settings(*self.arguments(fixture))

    def test_partial_domain_list_or_noninteger_counts_cannot_pass_exact_readback(self):
        for production in (False, True):
            for change in ('total', 'page', 'count'):
                fixture = self.fixture(production=production); config, root, api, workers, domains = fixture
                path = '/workers/domains?service=' + config['email']['name']; length = len(api.rows[path])
                info = {'page': 1, 'count': length, 'total_count': length}
                info[{'total': 'total_count', 'page': 'page', 'count': 'count'}[change]] = length + 1 if change == 'total' else True
                api.domain_info[path] = info
                with self.subTest(production=production, change=change), self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_DOMAIN_LIST_INCOMPLETE'):
                    verify_settings(*self.arguments(fixture))


if __name__ == '__main__':
    unittest.main()

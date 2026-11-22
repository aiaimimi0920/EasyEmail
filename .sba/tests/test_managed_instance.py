import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from data_resources import data_identity
from managed_instance import managed_state
from fixtures import configuration
from test_initial_resources import ResourceApi
from test_production_targets import production_configuration, TargetApi


class ManagedInstanceTests(unittest.TestCase):
    def test_existing_resources_do_not_require_empty_business_data_but_keep_identity_and_privacy_checks(self):
        config = configuration(); api = ResourceApi(config)
        api.overrides[config['email']['database']['id']] = [{'type': 'table', 'name': 'raw_mails'}]
        self.assertRegex(data_identity(config, api, require_empty=False), r'^[a-f0-9]{64}$')
        self.assertEqual(api.queries, [])
        api.rows['/r2/buckets/' + config['platform']['inboxBucket'] + '/domains/managed']['enabled'] = True
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_BUCKET_NOT_PRIVATE'): data_identity(config, api, require_empty=False)

    def test_isolated_existing_workers_are_required_and_resource_recreation_changes_witness(self):
        config = configuration(); api = ResourceApi(config)
        with self.assertRaises(DeploymentError): managed_state(config, api)
        api.rows['/workers/scripts'] = [{'id': config[role]['name']} for role in ('email', 'platform')]
        first = managed_state(config, api)
        api.rows['/workers/subdomain']['subdomain'] = 'foreign'
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_RESOURCE_MISMATCH'): managed_state(config, api)
        api.rows['/workers/subdomain']['subdomain'] = 'synthetic'
        api.rows['/r2/buckets/' + config['platform']['inboxBucket']]['creation_date'] = '2026-11-07T00:00:00Z'
        self.assertNotEqual(first, managed_state(config, api))

    def test_formal_domains_and_route_are_owned_and_read_only(self):
        config = production_configuration(); target = TargetApi(); resources = ResourceApi(config)
        resources.rows['/workers/scripts'] = [{'id': config[role]['name']} for role in ('email', 'platform')]
        target.rule.update(enabled=True, actions=[{'type': 'worker', 'value': [config['email']['name']]}])
        class Api:
            def account_zones(self): return target.account_zones()
            def get(self, path, zone=None):
                return target.get(path, zone) if zone else resources.get(path)
            def request(self, method, path):
                from urllib.parse import parse_qs, urlparse
                if path.startswith('/workers/domains?'):
                    hostname = parse_qs(urlparse(path).query)['hostname'][0]
                    role = next(role for role in ('email', 'platform') if config[role]['origin'] == 'https://' + hostname)
                    row = {'hostname': hostname, 'zone_id': target.zone['id'], 'zone_name': target.zone['name'],
                           'service': config[role]['name'], 'environment': 'production', 'enabled': True, 'previews_enabled': False}
                    return {'result': [row], 'result_info': {'page': 1, 'count': 1, 'total_count': 1}}
                raise AssertionError(path)
        api = Api(); first = managed_state(config, api)
        self.assertIsNotNone(first['routing']); self.assertEqual(target.writes, [])
        target.rule['actions'] = [{'type': 'worker', 'value': ['foreign']}]
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_EMAIL_ROUTE_CHANGED'): managed_state(config, api)
        self.assertEqual(target.writes, [])


if __name__ == '__main__': unittest.main()

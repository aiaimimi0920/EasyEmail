import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from initial_resources import fresh_resources, verify_database_initialization
from fixtures import configuration
from test_production_targets import production_configuration


class ResourceApi:
    def __init__(self, config):
        self.config, self.overrides, self.queries = config, {}, []
        self.rows = {'/workers/subdomain': {'subdomain': 'synthetic'}, '/workers/scripts': []}
        for role in ('email', 'platform'):
            row = config[role]['database']
            self.rows['/d1/database/' + row['id']] = {'uuid': row['id'], 'name': row['name'], 'created_at': '2026-11-06T00:00:00Z'}
        for field in ('inboxBucket', 'outboxBucket'):
            bucket = config['platform'][field]; path = '/r2/buckets/' + bucket
            self.rows[path] = {'name': bucket, 'creation_date': '2026-11-06T00:00:00Z'}
            self.rows[path + '/domains/managed'] = {'enabled': False}
            self.rows[path + '/domains/custom'] = {'domains': []}
            self.rows[path + '/objects?per_page=1'] = {'success': True, 'errors': [], 'result': []}

    def get(self, path):
        return copy.deepcopy(self.rows[path])

    def request(self, method, path):
        assert method == 'GET'
        return self.get(path)

    def query(self, database, sql):
        self.queries.append((database, sql))
        return self.overrides.get(database, [])


class InitialResourceTests(unittest.TestCase):
    def test_platform_provisioned_identity_and_empty_private_resources(self):
        config = configuration(); api = ResourceApi(config)
        self.assertRegex(fresh_resources(config, api), r'^[a-f0-9]{64}$')
        self.assertEqual(len(api.queries), 2)

    def test_wrong_account_existing_worker_and_nonempty_database_rejected(self):
        config = configuration()
        for change in ('account', 'worker', 'database'):
            api = ResourceApi(config)
            if change == 'account': api.rows['/workers/subdomain']['subdomain'] = 'different'
            if change == 'worker': api.rows['/workers/scripts'] = [{'id': config['email']['name']}]
            if change == 'database': api.overrides[config['email']['database']['id']] = [{'type': 'table', 'name': 'users'}]
            with self.subTest(change=change), self.assertRaises(DeploymentError):
                fresh_resources(config, api)

    def test_formal_first_deploy_uses_the_same_fresh_private_resource_gates(self):
        config = production_configuration(); api = ResourceApi(config)
        # Custom domains do not depend on, or implicitly enable, the account's workers.dev subdomain.
        del api.rows['/workers/subdomain']
        self.assertRegex(fresh_resources(config, api), r'^[a-f0-9]{64}$')
        for change in ('worker', 'nonempty-db', 'wrong-db', 'public-bucket'):
            api = ResourceApi(config)
            if change == 'worker': api.rows['/workers/scripts'] = [{'id': config['platform']['name']}]
            elif change == 'nonempty-db': api.overrides[config['platform']['database']['id']] = [{'type': 'table', 'name': 'users'}]
            elif change == 'wrong-db': api.rows['/d1/database/' + config['email']['database']['id']]['name'] = 'foreign'
            else: api.rows['/r2/buckets/' + config['platform']['outboxBucket'] + '/domains/managed']['enabled'] = True
            with self.subTest(change=change), self.assertRaises(DeploymentError): fresh_resources(config, api)

    def test_all_migration_names_and_both_database_integrity_are_required(self):
        scratch = Path(os.environ.get('EASYEMAIL_TEST_ROOT', tempfile.gettempdir()))
        release = Path(tempfile.mkdtemp(prefix='sba-migration-check-', dir=scratch))
        directory = release / 'publish/platform/migrations'; directory.mkdir(parents=True)
        source = Path(__file__).resolve().parents[2] / 'service/cloudflare/migrations'
        names = sorted(file.name for file in source.glob('*.sql'))
        for name in names: (directory / name).write_text('', encoding='utf8')
        config = configuration()
        for failure in (None, 'missing-migration', 'foreign-key'):
            def query(database, sql):
                if sql == 'SELECT name FROM d1_migrations ORDER BY name':
                    return [{'name': name} for name in (names[:-1] if failure == 'missing-migration' else names)]
                if sql == 'PRAGMA foreign_key_check': return [{'table': 'users'}] if failure == 'foreign-key' else []
                if sql == 'PRAGMA quick_check': return [{'quick_check': 'ok'}]
                return [{'name': name} for name in ('raw_mail_resources', 'mail_delete_operations', 'address_delete_operations',
                                                   'raw_mail_resource_insert', 'raw_mail_resource_update', 'raw_mail_resource_delete')]
            api = Mock(); api.query.side_effect = query
            if failure is None:
                verify_database_initialization(config, api, release)
            else:
                with self.subTest(failure=failure), self.assertRaises(DeploymentError):
                    verify_database_initialization(config, api, release)

    def test_bucket_exposure_nonempty_and_unfinished_empty_page_rejected(self):
        config = configuration(); path = '/r2/buckets/' + config['platform']['inboxBucket']
        for suffix, value in [('/domains/managed', {'enabled': True}), ('/domains/custom', {'domains': [{'domain': 'public.example.com'}]}),
                              ('/objects?per_page=1', {'result': [{'key': 'private'}]}),
                              ('/objects?per_page=1', {'result': [], 'result_info': {'is_truncated': True}})]:
            api = ResourceApi(config); api.rows[path + suffix] = value
            with self.subTest(suffix=suffix, value=value), self.assertRaises(DeploymentError):
                fresh_resources(config, api)


if __name__ == '__main__':
    unittest.main()

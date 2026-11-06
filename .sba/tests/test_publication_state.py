import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from publication_state import partial_state
import test_published_settings


class PublicationStateTests(unittest.TestCase):
    def fixture(self):
        config, release, api, workers, _ = test_published_settings.PublishedSettingsTests().fixture(production=True)
        path = '/workers/scripts/' + config['email']['name']
        api.rows['/workers/scripts'] = [{'id': config['email']['name'], 'created_on': '2026-11-01T00:00:00Z'}]
        api.rows[path + '/schedules'] = {'schedules': []}
        api.rows['/workers/domains?service=' + config['email']['name']] = []
        original = api.request
        objects = {'result': [], 'result_info': {'is_truncated': False, 'cursor': None}}

        def request(method, suffix):
            if suffix.startswith('/r2/buckets/'): return copy.deepcopy(objects)
            return original(method, suffix)
        api.request = request
        return config, release, api, workers, objects

    def verify(self, fixture):
        config, release, api, workers, _ = fixture
        with patch('publication_state.verify_database_initialization'), \
             patch('publication_state.uninitialized_databases', return_value={'synthetic': 'empty'}), \
             patch('publication_state.data_identity', return_value='identity'):
            return partial_state(config, api, release, workers)

    def test_only_email_uploaded_no_triggers_or_business_objects_is_admitted(self):
        result = self.verify(self.fixture())
        self.assertEqual(result['identity'], 'identity')
        self.assertEqual(result['databases'], {'synthetic': 'empty'})

    def test_existing_platform_wrong_bindings_or_exposed_email_cannot_be_repaired(self):
        for change in ('platform', 'missing-email', 'duplicate', 'database', 'preview', 'cron', 'domain', 'object', 'truncated'):
            fixture = self.fixture(); config, release, api, workers, objects = fixture
            path = '/workers/scripts/' + config['email']['name']
            if change == 'platform': api.rows['/workers/scripts'].append({'id': config['platform']['name']})
            elif change == 'missing-email': api.rows['/workers/scripts'].clear()
            elif change == 'duplicate': api.rows['/workers/scripts'] *= 2
            elif change == 'database':
                next(row for row in api.rows[path + '/settings']['bindings'] if row['name'] == 'DB')['id'] = 'foreign'
            elif change == 'preview': api.rows[path + '/subdomain']['previews_enabled'] = True
            elif change == 'cron': api.rows[path + '/schedules']['schedules'] = [{'cron': '* * * * *'}]
            elif change == 'domain': api.rows['/workers/domains?service=' + config['email']['name']] = [{'hostname': 'foreign.example.com'}]
            elif change == 'object': objects['result'] = [{'key': 'must-not-overwrite'}]
            else: objects['result_info']['is_truncated'] = True
            with self.subTest(change=change), self.assertRaises(DeploymentError): self.verify(fixture)

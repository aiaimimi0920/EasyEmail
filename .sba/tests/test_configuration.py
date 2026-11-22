import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from configuration import configuration, descriptor, inventory
from contract import DeploymentError
from fixtures import configuration as fixture


class ConfigurationTests(unittest.TestCase):
    def test_isolated_workers_dev_and_null_mail_target(self):
        value = configuration(fixture())
        self.assertEqual(len(inventory(value)), 8)
        self.assertEqual(descriptor(value)['acceptance'], {'workersDev': True})
        self.assertEqual(descriptor(value)['email']['domains'], [value['mailDomain']])

    def test_production_mail_identity_matches_platform_order(self):
        value = fixture()
        value['mailDomain'] = 'example.com'
        value['routing'] = {'zoneId': 'c' * 32, 'domain': 'example.com'}
        value['email']['origin'] = 'https://email-api.example.com'
        value['platform']['origin'] = 'https://mail.example.com'
        value = configuration(value)
        self.assertNotIn('acceptance', descriptor(value))
        self.assertEqual(inventory(value)[-1], {'key': 'target-4', 'kind': 'email-routing',
                         'accountId': 'a' * 32, 'remoteId': 'email-routing:' + 'c' * 32,
                         'name': 'email-routing:' + 'c' * 32})

    def test_workers_dev_is_not_a_backdoor_to_real_mail(self):
        for edit in [lambda v: v.update(mailDomain='example.com'),
                     lambda v: v.update(routing={'zoneId': 'c' * 32, 'domain': v['mailDomain']}),
                     lambda v: v['settings'].update(sendRecipients=['a@example.com']),
                     lambda v: v['settings'].update(providers=[{'id': 'external'}]),
                     lambda v: v['settings'].update(imapEndpoints=[{}]),
                     lambda v: v['settings'].update(providerOrigins=['https://api.example.com']),
                     lambda v: v['email'].update(name='production-email')]:
            with self.subTest(edit=edit):
                value = fixture(); edit(value)
                with self.assertRaises(DeploymentError):
                    configuration(value)

    def test_mixed_origins_and_account_subdomains_rejected(self):
        for url in ['https://mail.example.com', 'https://test-123456abcdef-platform.other.workers.dev']:
            value = fixture(); value['platform']['origin'] = url
            with self.assertRaises(DeploymentError):
                configuration(value)

    def test_public_shape_rejects_unknown_secrets_and_invalid_types(self):
        edits = [lambda v: v.update(apiKey='must-not-be-accepted'), lambda v: v.update(accountId=3),
                 lambda v: v['email']['database'].update(id='00000000-0000-0000-0000-000000000000'),
                 lambda v: v['platform']['database'].update(name=v['email']['database']['name']),
                 lambda v: v['settings'].update(sendRecipients=['*']),
                 lambda v: v['settings'].update(providers=[{'id': 'external', 'apiKey': 'secret'}])]
        for edit in edits:
            with self.subTest(edit=edit):
                value = fixture(); edit(value)
                with self.assertRaises(DeploymentError):
                    configuration(value)

    def test_routing_domain_must_be_exact_mail_domain(self):
        value = fixture(); value['mailDomain'] = 'example.com'
        value['email']['origin'] = 'https://email-api.example.com'
        value['platform']['origin'] = 'https://mail.example.com'
        for routing in [{'zoneId': 'c' * 32, 'domain': 'other.com'},
                        {'zoneId': '0' * 32, 'domain': 'example.com'},
                        {'zoneId': 'c' * 32, 'domain': 'example.com', 'enabled': True}]:
            value['routing'] = routing
            with self.assertRaises(DeploymentError):
                configuration(value)

    def test_parsing_does_not_mutate_callers_configuration(self):
        value = fixture(); before = copy.deepcopy(value)
        parsed = configuration(value); parsed['settings']['providers'].append({})
        self.assertEqual(value, before)


if __name__ == '__main__':
    unittest.main()

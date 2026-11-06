import copy
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from configuration import inventory
from contract import validate_context, validated_request
from fixtures import repair_request, request


ROOT = Path(__file__).resolve().parents[2]


class ContractTests(unittest.TestCase):
    def git(self, command, **options):
        self.assertNotIn('CLOUDFLARE_API_TOKEN', options['env'])
        self.assertNotIn('EE_MASTER_KEY', options['env'])
        self.assertNotIn('GIT_CONFIG_COUNT', options['env'])
        self.assertEqual(options['env']['GIT_CONFIG_GLOBAL'], os.devnull)
        args = command[3:]
        if args == ['rev-parse', 'HEAD']: return 'b' * 40
        if args == ['remote', 'get-url', 'origin']: return 'https://github.com/aiaimimi0920/EasyEmail.git'
        if args[0] == 'status': return ''
        if args[0] == 'ls-files': return 'H .sba/application.py'
        raise AssertionError(command)

    def test_source_validation_git_does_not_inherit_secrets_or_configuration_injection(self):
        with patch.dict(os.environ, {'CLOUDFLARE_API_TOKEN': 'secret', 'EE_MASTER_KEY': 'secret', 'GIT_CONFIG_COUNT': '1'}), \
                patch('contract.subprocess.check_output', side_effect=self.git):
            self.assertEqual(validated_request(request(), ROOT), request())

    def test_wrong_source_previous_release_and_dirty_index_are_rejected(self):
        selected = request()
        for mutate in [lambda r: r.update(sourceSha='d' * 40), lambda r: r.update(previous={}),
                       lambda r: r.update(applicationVersion='9.0.0')]:
            invalid = copy.deepcopy(selected); mutate(invalid)
            with patch('contract.subprocess.check_output', side_effect=self.git), self.assertRaises(DeploymentError):
                validated_request(invalid, ROOT)
        with patch('contract.subprocess.check_output', side_effect=['b' * 40, 'https://github.com/aiaimimi0920/EasyEmail.git', ' M source.ts']), \
                self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SOURCE_DIRTY'):
            validated_request(selected, ROOT)

    def preview(self):
        target = request('preview'); source = request()['configuration']
        source['email']['origin'] = 'https://email-api.example.com'
        source['platform']['origin'] = 'https://mail.example.com'
        source['mailDomain'] = 'example.com'; source['routing'] = {'zoneId': 'c' * 32, 'domain': 'example.com'}
        source['email']['database']['id'] = '33333333-3333-3333-3333-333333333333'
        source['platform']['database']['id'] = '44444444-4444-4444-4444-444444444444'
        source['email']['name'] = 'production-email'; source['platform']['name'] = 'production-platform'
        source['platform']['inboxBucket'] = 'production-inbox'; source['platform']['outboxBucket'] = 'production-outbox'
        target['previous'] = {'sourceSha': 'd' * 40, 'applicationVersion': '0.9.0'}
        target['context'] = {'source': {**target['previous'], 'instanceId': 'dc-' + '2' * 32, 'taskId': 'dc-' + '3' * 32,
                             'environment': 'production', 'configuration': source, 'resources': inventory(source), 'resultDigest': 'e' * 64},
                             'resources': inventory(target['configuration']),
                             'urls': [target['configuration'][role]['origin'] for role in ('email', 'platform')]}
        return target

    def test_preview_allows_source_mail_identity_but_not_any_mail_write_target(self):
        selected = self.preview(); validate_context(selected)
        selected['context']['resources'].append(selected['context']['source']['resources'][-1])
        with self.assertRaises(DeploymentError): validate_context(selected)

    def test_preview_requires_workers_dev_even_when_custom_domain_uses_the_target_name(self):
        selected = self.preview()
        for role in ('email', 'platform'):
            selected['configuration'][role]['origin'] = 'https://' + selected['configuration'][role]['name'] + '.example.com'
        selected['context']['resources'] = inventory(selected['configuration'])
        selected['context']['urls'] = [selected['configuration'][role]['origin'] for role in ('email', 'platform')]
        with self.assertRaises(DeploymentError): validate_context(selected)
        selected = self.preview(); selected['configuration']['routing'] = selected['context']['source']['configuration']['routing']
        selected['context']['resources'] = inventory(selected['configuration'])
        with self.assertRaises(DeploymentError): validate_context(selected)

    def test_repair_accepts_a_newer_fixed_version_and_explicit_parent_evidence(self):
        value = repair_request()
        with patch('contract.subprocess.check_output', side_effect=self.git):
            self.assertEqual(validated_request(value, ROOT), value)

    def test_fresh_publication_repair_uses_declared_template_and_authenticated_parent_fields(self):
        from test_publication_repair import publication_request
        value = publication_request()
        with patch('contract.subprocess.check_output', side_effect=self.git):
            self.assertEqual(validated_request(value, ROOT), value)
        for change in ('errorCode', 'parentRunId', 'resultDigest'):
            invalid = copy.deepcopy(value); invalid['context'][change] = 'invalid'
            with self.subTest(change=change), patch('contract.subprocess.check_output', side_effect=self.git), self.assertRaises(DeploymentError):
                validated_request(invalid, ROOT)

    def test_repair_rejects_unknown_operation_incomplete_parent_and_same_version(self):
        mutations = [lambda r: r['context'].update(repairId='arbitrary-replay'),
                     lambda r: r['context'].update(errorCode='EASYEMAIL_UNEXPECTED_FAILURE'),
                     lambda r: r['context'].update(parentTaskId=r['taskId']),
                     lambda r: r['context'].update(parentRunId=True),
                     lambda r: r['context'].update(requestDigest='bad'),
                     lambda r: r['context'].update(extra='not-permitted'),
                     lambda r: r.update(previous={'sourceSha': r['sourceSha'], 'applicationVersion': r['applicationVersion']})]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                value = repair_request(); mutate(value)
                with patch('contract.subprocess.check_output', side_effect=self.git), self.assertRaises(DeploymentError):
                    validated_request(value, ROOT)


if __name__ == '__main__':
    unittest.main()

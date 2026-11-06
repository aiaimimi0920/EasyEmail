import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from contract import validated_request
from fixtures import preview_repair_request
from release import prepare_release
import test_contract

ROOT = test_contract.ROOT


class PreviewRepairContractTests(unittest.TestCase):
    def test_exact_preview_parent_is_accepted_only_by_its_declared_repair(self):
        value = preview_repair_request()
        with patch('contract.subprocess.check_output', side_effect=test_contract.ContractTests().git):
            self.assertEqual(validated_request(value, ROOT), value)

    def test_missing_context_retargeted_source_or_undeclared_action_is_rejected(self):
        mutations = [lambda r: r['context'].pop('preview'),
                     lambda r: r['context'].update(repairId='complete-empty-bootstrap'),
                     lambda r: r['context']['preview']['source'].update(sourceSha=r['sourceSha']),
                     lambda r: r['context']['preview']['source'].update(sourceSha=r['previous']['sourceSha']),
                     lambda r: r['context']['preview']['source'].update(taskId=r['context']['parentTaskId']),
                     lambda r: r['context']['preview']['resources'].pop(),
                     lambda r: r['context']['preview']['urls'].append('https://other.example.com'),
                     lambda r: r['configuration'].update(routing={'zoneId': 'c' * 32, 'domain': r['configuration']['mailDomain']})]
        for mutate in mutations:
            value = preview_repair_request(); mutate(value)
            with self.subTest(mutate=mutate), patch('contract.subprocess.check_output', side_effect=test_contract.ContractTests().git), \
                    self.assertRaises(DeploymentError):
                validated_request(value, ROOT)

    def test_continuation_baseline_is_bounded_and_not_the_source_or_current_candidate(self):
        value = preview_repair_request(); baseline = {**value['previous'], 'instanceId': value['context']['parentTaskId']}
        value['previous'] = {'sourceSha': 'e' * 40, 'applicationVersion': '1.0.4'}
        value['context'].update(errorCode='EASYEMAIL_SOURCE_DATABASE_CHANGED', previewBaseline=baseline)
        with patch('contract.subprocess.check_output', side_effect=test_contract.ContractTests().git):
            self.assertEqual(validated_request(value, ROOT), value)
        import copy
        for invalid_baseline in ({**baseline, 'extra': True}, {**baseline, 'sourceSha': value['sourceSha']},
                                 {**baseline, 'sourceSha': value['context']['preview']['source']['sourceSha']},
                                 {**baseline, 'applicationVersion': '9.0.0'}):
            invalid = copy.deepcopy(value); invalid['context']['previewBaseline'] = invalid_baseline
            with patch('contract.subprocess.check_output', side_effect=test_contract.ContractTests().git), self.assertRaises(DeploymentError):
                validated_request(invalid, ROOT)

    def test_repair_build_uses_full_preview_isolation_policy_with_original_configuration_digest(self):
        root = Path(tempfile.mkdtemp(prefix='repair-build-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        output = root / 'build'
        dependencies = json.loads((ROOT / '.sba/dependencies.json').read_text(encoding='utf8'))
        value = preview_repair_request()
        class Runner:
            def __init__(self, directory): Path(directory).mkdir()
            def executable(self, name): return name
            def run(self, command, cwd, label): pass
            def output(self, command, cwd):
                if command[-1] == '--version':
                    return dependencies['pnpm'] if 'pnpm.cjs' in str(command) else dependencies['npm'] if 'npm-cli.js' in str(command) else 'v22.22.2'
                if command[-2:] == ['rev-parse', 'HEAD']:
                    return dependencies['neuroDesign']['commit'] if Path(cwd).name == 'NeuroDesign' else value['sourceSha']
                return ''
        with patch('release.BuildRunner', Runner): prepare_release(value, output)
        public = json.loads((output / 'release-input.json').read_text(encoding='utf8'))
        self.assertIs(public['preview'], True)
        self.assertEqual(public['descriptor']['email']['origin'], value['configuration']['email']['origin'])
        self.assertEqual(public['providers'], [])
        self.assertNotIn('EE_MASTER_KEY', json.dumps(public))


if __name__ == '__main__': unittest.main()

import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from contract import validated_request
from configuration import inventory
from fixtures import repair_request
import test_contract


def cleanup_request():
    value = repair_request()
    value['previous'] = {'sourceSha': 'd' * 40, 'applicationVersion': '1.0.6'}
    value['context'].update(repairId='complete-preview-cleanup', errorCode='EASYEMAIL_PREVIEW_CLEANUP_SHARED_OR_UNVERIFIED',
        cleanup={**value['previous'], 'context': {'instanceId': 'dc-' + '3' * 32, 'previewTaskId': 'dc-' + '4' * 32,
            'resultDigest': 'a' * 64, 'resources': inventory(value['configuration'])}})
    return value


class CleanupRepairContractTests(unittest.TestCase):
    def test_cleanup_repair_is_a_new_version_with_only_the_original_isolated_cleanup_authority(self):
        value = cleanup_request()
        with patch('contract.subprocess.check_output', side_effect=test_contract.ContractTests().git):
            self.assertEqual(validated_request(value, test_contract.ROOT), value)

    def test_cleanup_repair_rejects_retargeting_mixed_context_or_other_repair_templates(self):
        for mutate in (lambda r: r['context'].pop('cleanup'),
                       lambda r: r['context'].update(repairId='complete-empty-bootstrap'),
                       lambda r: r['context'].update(preview={}),
                       lambda r: r['context']['cleanup'].update(sourceSha=r['sourceSha']),
                       lambda r: r['context']['cleanup'].update(applicationVersion='9.0.0'),
                       lambda r: r['context']['cleanup']['context'].update(previewTaskId=r['context']['parentTaskId']),
                       lambda r: r['context']['cleanup']['context']['resources'].pop(),
                       lambda r: r['configuration'].update(routing={'zoneId': 'c' * 32, 'domain': 'example.com'})):
            invalid = copy.deepcopy(cleanup_request()); mutate(invalid)
            with patch('contract.subprocess.check_output', side_effect=test_contract.ContractTests().git), self.assertRaises(DeploymentError):
                validated_request(invalid, test_contract.ROOT)


if __name__ == '__main__': unittest.main()

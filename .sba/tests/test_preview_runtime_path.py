import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from preview_credentials import preview_material, rewrite_self
import test_contract
from test_deploy_secrets import secret_environment


class PreviewRuntimePathTests(unittest.TestCase):
    def setUp(self):
        self.application = Path(__file__).resolve().parents[2]
        self.directory = Path(tempfile.mkdtemp(prefix='preview-runtime-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        request = test_contract.ContractTests().preview()
        self.source = request['context']['source']['configuration']
        self.target = request['configuration']
        self.material = preview_material(self.source, self.target, secret_environment())

    def test_clean_executor_checkout_uses_built_application_dependencies(self):
        clean = self.directory / 'application' / '.sba'; clean.mkdir(parents=True)
        for filename in ('preview_credentials.py', 'preview-vault.mjs'):
            shutil.copyfile(self.application / '.sba' / filename, clean / filename)
        spec = importlib.util.spec_from_file_location('clean_preview_credentials', clean / 'preview_credentials.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        # The executor checkout has no npm dependencies; the build checkout owns them.
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_PREVIEW_CREDENTIAL_FAILED'):
            module.rewrite_self([], [], self.source, self.target, *self.material)
        result = module.rewrite_self([], [], self.source, self.target, *self.material, application_root=self.application)
        self.assertEqual(result, {'mailboxes': [], 'providers': []})
        self.assertFalse((clean.parent / 'service/cloudflare/node_modules').exists())

    def test_selected_runtime_has_credential_free_environment_and_private_stdin(self):
        class Result:
            returncode = 0
            stdout = b'{"mailboxes":[],"providers":[]}'
        with patch('preview_credentials.subprocess.run', return_value=Result()) as run:
            rewrite_self([], [], self.source, self.target, *self.material, application_root=self.application)
        args, kwargs = run.call_args
        self.assertEqual(Path(args[0][1]), self.application / '.sba/preview-vault.mjs')
        self.assertEqual(kwargs['cwd'], self.application / '.sba')
        self.assertNotIn('EE_MASTER_KEY', kwargs['env'])
        self.assertNotIn('NODE_OPTIONS', kwargs['env'])
        self.assertNotIn(self.material[0].workers['email']['JWT_SECRET'], ' '.join(args[0]))
        self.assertIn(self.material[0].workers['email']['JWT_SECRET'].encode(), kwargs['input'])


if __name__ == '__main__': unittest.main()

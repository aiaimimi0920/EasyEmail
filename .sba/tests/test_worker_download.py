import hashlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from fixtures import configuration
from worker_download import verify_uploaded_email


SCRATCH = Path(os.environ.get('EASYEMAIL_TEST_ROOT', tempfile.gettempdir()))


class WorkerDownloadTests(unittest.TestCase):
    def check(self, modules):
        root = Path(tempfile.mkdtemp(prefix='sba-worker-bytes-', dir=SCRATCH)); (root / 'email-dry-run').mkdir()
        (root / 'email-dry-run/sba-entry.mjs').write_bytes(b'export default {};\n')
        parts = [b'--fixture\r\nContent-Disposition: form-data; name="' + name.encode() + b'"\r\n\r\n' + value + b'\r\n'
                 for name, value in modules]
        class Response(io.BytesIO):
            status = 200
            headers = {'Content-Type': 'multipart/form-data; boundary=fixture'}
        response = Response(b''.join(parts) + b'--fixture--\r\n')
        api = SimpleNamespace(account='a' * 32, token='synthetic', transport=SimpleNamespace(
            opener=SimpleNamespace(open=lambda request, timeout: response)))
        return verify_uploaded_email(configuration(), api, root / 'release')

    def test_exact_executable_bytes_match_with_or_without_nonexecuted_map_sidecar(self):
        modules = [('sba-entry.mjs', b'export default {};\n')]
        for rows in (modules, modules + [('sba-entry.mjs.map', b'{"version":3}')]):
            self.assertEqual(self.check(rows), hashlib.sha256(modules[0][1]).hexdigest())

    def test_modified_code_duplicate_or_extra_executable_module_is_rejected(self):
        module = ('sba-entry.mjs', b'export default {};\n')
        for rows in ([('sba-entry.mjs', b'foreign code')], [module, module], [module, ('extra.js', b'foreign code')]):
            with self.subTest(rows=rows), self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_PARENT_WORKER_UNVERIFIED'):
                self.check(rows)

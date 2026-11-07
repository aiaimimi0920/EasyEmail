import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from readiness_parent import verify_parent_assets
import test_public_verify

SCRATCH = Path(os.environ.get('EASYEMAIL_TEST_ROOT', tempfile.gettempdir()))


class ReadinessParentTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_public_verify.PublicVerifyTests(); self.fixture.setUp()
        self.release = Path(tempfile.mkdtemp(prefix='sba-parent-assets-', dir=SCRATCH))
        (self.release / 'publish/platform/web').mkdir(parents=True)
        (self.release / 'publish/platform/web/index.html').write_bytes(self.fixture.body)
        (self.release / 'sba-release.json').write_text(json.dumps({'markers': self.fixture.markers}), encoding='utf8')

    def test_only_parent_origin_entry_is_reconstructed_and_public_js_is_actually_read(self):
        verify_parent_assets(self.fixture.request, self.release, self.fixture.read)
        self.assertFalse(any(url.endswith('/') for url, _ in self.fixture.calls))
        self.assertTrue(any(url.endswith('/assets/app.js') for url, _ in self.fixture.calls))

    def test_foreign_marker_network_asset_or_rebuilt_origin_html_fails(self):
        for change in ('marker', 'script', 'origin'):
            with self.subTest(change=change):
                self.setUp()
                if change == 'marker': self.fixture.markers['platform']['sourceSha'] = 'f' * 40
                elif change == 'script': self.fixture.script += b'changed'
                else: (self.release / 'publish/platform/web/index.html').write_bytes(b'foreign')
                with self.assertRaises(DeploymentError): verify_parent_assets(self.fixture.request, self.release, self.fixture.read)

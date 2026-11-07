import hashlib
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError, digest
from fixtures import request
from public_verify import ReleaseReader, verify_public


class PublicVerifyTests(unittest.TestCase):
    def test_release_reader_identifies_itself_without_cookies_credentials_or_a_browser_signature(self):
        response = MagicMock(); response.status = 200; response.headers = {}
        response.__enter__.return_value = response; response.read.return_value = b'OK'
        opener = MagicMock(); opener.open.return_value = response
        self.assertEqual(ReleaseReader(opener).read('https://public.example.com/health_check'), b'OK')
        sent = opener.open.call_args.args[0]
        self.assertEqual(sent.get_header('User-agent'), 'EasyEmail-SBA/1.0')
        self.assertFalse(sent.has_header('Authorization') or sent.has_header('Cookie'))
        self.assertEqual(sent.method, 'GET'); self.assertEqual(opener.open.call_count, 1)

    def setUp(self):
        self.request = request('verify')
        self.body = b'<html>synthetic</html>'
        self.script = b'console.log("synthetic");'
        self.calls = []
        self.markers = {}
        for role in ('email', 'platform'):
            marker = {key: self.request[key] for key in ('applicationId', 'applicationVersion', 'sourceSha')}
            marker.update(schemaVersion=1, component=role, configurationDigest=digest(self.request['configuration']), assets=[])
            if role == 'platform':
                marker['assets'] = [{'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                                    for path, data in [('/', self.body), ('/assets/app.js', self.script)]]
            self.markers[role] = marker

    def read(self, url, status=200, limit=8 * 1024 * 1024):
        self.calls.append((url, status))
        role = 'platform' if '-platform.' in url else 'email'
        if url.endswith('/.well-known/easyemail-release.json'):
            return json.dumps(self.markers[role]).encode()
        if url.endswith('/healthz'):
            return b'{"service":"easyemail-cloudflare","status":"alive"}'
        if url.endswith('/health_check'):
            return b'OK'
        if url.endswith('/api/v1/me'):
            self.assertEqual(status, 401)
            return b'{"error":{"code":"unauthorized"}}'
        if url.endswith('/assets/app.js'):
            return self.script
        if url.endswith('/'):
            return self.body
        raise AssertionError(url)

    def test_exact_release_health_anonymous_boundary_and_asset_bytes(self):
        with patch.dict('os.environ', {'CLOUDFLARE_API_TOKEN': 'verification-not-applicable', 'EE_MASTER_KEY': 'verification-not-applicable'}):
            checks = verify_public(self.request, self.read)
        self.assertTrue(all(row['passed'] for row in checks))
        self.assertEqual(len(self.calls), 7)

    def test_wrong_source_configuration_or_role_fails(self):
        for field, value in [('sourceSha', 'd' * 40), ('applicationVersion', '9.0.0'),
                             ('configurationDigest', 'c' * 64), ('component', 'email')]:
            with self.subTest(field=field):
                original = self.markers['platform'][field]
                self.markers['platform'][field] = value
                with self.assertRaises(DeploymentError):
                    verify_public(self.request, self.read)
                self.markers['platform'][field] = original

    def test_binary_origin_entry_is_exact_even_when_the_delivered_html_has_edge_injections(self):
        self.markers['platform']['assets'][0]['verificationPath'] = '/.well-known/easyemail-entry.bin'
        self.body = b'<!doctype html><html><div id="root"></div><script type="module" src="/assets/app.js"></script></html>'
        asset = self.markers['platform']['assets'][0]
        asset.update(bytes=len(self.body), sha256=hashlib.sha256(self.body).hexdigest())
        def read(url, **kwargs):
            if url.endswith('/.well-known/easyemail-entry.bin'): return self.body
            if url.endswith('/'): return self.body.replace(b'</html>', b'<script>edge-generated</script></html>')
            return self.read(url, **kwargs)
        checks = verify_public(self.request, read)
        self.assertIn('public-entrypoint-ready', [row['id'] for row in checks])
        with self.assertRaises(DeploymentError):
            verify_public(self.request, lambda url, **kwargs: b'foreign' if url.endswith('.bin') else read(url, **kwargs))
        with self.assertRaises(DeploymentError):
            verify_public(self.request, lambda url, **kwargs: b'not-an-entry' if url.endswith('/') else read(url, **kwargs))

    def test_origin_entry_evidence_cannot_redirect_or_replace_a_non_entry_asset(self):
        for value in ('https://foreign.example.com/source', '/api/v1/admin', '/.well-known/easyemail-entry.bin?query=1'):
            self.markers['platform']['assets'][0]['verificationPath'] = value
            with self.subTest(value=value), self.assertRaises(DeploymentError): verify_public(self.request, self.read)
        del self.markers['platform']['assets'][0]['verificationPath']
        self.markers['platform']['assets'][1]['verificationPath'] = '/.well-known/easyemail-entry.bin'
        with self.assertRaises(DeploymentError): verify_public(self.request, self.read)

    def test_corrupted_or_foreign_asset_rejected(self):
        self.script += b'changed'
        with self.assertRaises(DeploymentError):
            verify_public(self.request, self.read)
        self.markers['platform']['assets'][1]['path'] = 'https://foreign.example.com/steal'
        self.calls.clear()
        with self.assertRaises(DeploymentError):
            verify_public(self.request, self.read)
        self.assertFalse(any('foreign' in url for url, _ in self.calls))

    def test_release_reader_rejects_redirect_cookie_and_oversized_response(self):
        class Response:
            status = 200
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, size): return b'x' * size
        for status, headers in [(302, {}), (200, {'set-cookie': 'unexpected=1'}), (200, {})]:
            response = Response(); response.status = status; response.headers = headers
            opener = unittest.mock.Mock(); opener.open.return_value = response
            with self.subTest(status=status, headers=headers), self.assertRaises(DeploymentError):
                ReleaseReader(opener).read('https://public.example.com/path', limit=10)
            sent = opener.open.call_args.args[0]
            self.assertEqual(sent.method, 'GET')
            self.assertFalse(sent.has_header('Authorization') or sent.has_header('Cookie'))


if __name__ == '__main__':
    unittest.main()

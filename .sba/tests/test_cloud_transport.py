import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from urllib.parse import parse_qs, urlparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cloud_transport import CloudApi, OperationState
from boundary import DeploymentError


SCRATCH = Path(os.environ.get('EASYEMAIL_TEST_ROOT', tempfile.gettempdir()))


class Response(io.BytesIO):
    def __init__(self, value, status=200):
        super().__init__(json.dumps(value).encode()); self.status = status
        self.headers = {'Content-Type': 'application/json'}


class Opener:
    def __init__(self, response=None, error=None):
        self.response, self.error, self.calls = response, error, []

    def open(self, request, timeout):
        self.calls.append(request)
        if self.error:
            raise self.error
        return self.response


class SequenceOpener(Opener):
    def __init__(self, values):
        super().__init__(); self.values = iter(values)

    def open(self, request, timeout):
        self.calls.append(request); value = next(self.values)
        if isinstance(value, Exception): raise value
        return Response(value)


def zone_page(page, rows, total, pages=None):
    return {'success': True, 'errors': [], 'result': rows,
            'result_info': {'page': page, 'per_page': 50, 'count': len(rows), 'total_count': total,
                            'total_pages': (total + 49) // 50 if pages is None else pages}}


class CloudTransportTests(unittest.TestCase):
    def state(self):
        return OperationState(Path(tempfile.mkdtemp(prefix='sba-operation-', dir=SCRATCH)), 'dc-' + '1' * 32)

    def test_read_query_does_not_claim_a_mutation_and_secrets_stay_in_headers(self):
        opener = Opener(Response({'success': True, 'errors': [], 'result': [{'success': True, 'results': []}]}))
        state = self.state(); client = CloudApi('a' * 32, 'synthetic-cloud-token', state, opener)
        self.assertEqual(client.query('11111111-1111-1111-1111-111111111111', 'SELECT 1'), [])
        self.assertFalse(state.attempted)
        self.assertEqual(len(opener.calls), 1)
        self.assertNotIn('synthetic-cloud-token', opener.calls[0].full_url)
        self.assertNotIn('synthetic-cloud-token', state.path.read_text(encoding='utf8'))

    def test_lost_mutation_response_is_persisted_once_and_never_retried(self):
        state = self.state(); opener = Opener(error=urllib.error.URLError('synthetic-private-error'))
        client = CloudApi('a' * 32, 'synthetic-cloud-token', state, opener)
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_CLOUD_REQUEST_FAILED'):
            client.query('11111111-1111-1111-1111-111111111111', 'CREATE TABLE sample(id)', write='schema-started')
        self.assertTrue(state.attempted); self.assertEqual(len(opener.calls), 1)
        record = json.loads(state.path.read_text(encoding='utf8'))
        self.assertEqual(record['writes'], ['schema-started'])
        self.assertNotIn('private', state.path.read_text(encoding='utf8'))

    def test_failed_envelope_redirect_and_oversized_response_fail_closed(self):
        for response in [Response({'success': False, 'errors': [{'message': 'private'}], 'result': []}),
                         Response({'success': True, 'errors': [], 'result': []}, status=302),
                         Response({'result': 'x' * (1024 * 1024 + 1)})]:
            with self.subTest(status=response.status), self.assertRaises(DeploymentError):
                CloudApi('a' * 32, 'synthetic-token', self.state(), Opener(response)).get('/workers/scripts')

    def test_worker_domain_get_accepts_observed_null_errors_without_changing_the_envelope(self):
        for errors in (None, []):
            value = {'success': True, 'errors': errors, 'result': [], 'result_info': {'page': 1, 'count': 0, 'total_count': 0}}
            state = self.state(); client = CloudApi('a' * 32, 'token', state, Opener(Response(value)))
            self.assertEqual(client.request('GET', '/workers/domains?service=test-selected'), value)
            self.assertFalse(state.attempted)

    def test_domain_null_errors_exception_never_accepts_failures_missing_errors_other_endpoints_or_writes(self):
        for method, suffix, body in [
            ('GET', '/workers/domains?hostname=selected.test', {'success': False, 'errors': None, 'result': []}),
            ('GET', '/workers/domains?service=selected', {'success': True, 'result': []}),
            ('GET', '/workers/domains?service=selected', {'success': True, 'errors': [{'code': 10000}], 'result': []}),
            ('GET', '/workers/scripts', {'success': True, 'errors': None, 'result': []}),
            ('POST', '/workers/domains', {'success': True, 'errors': None, 'result': []})]:
            state = self.state(); client = CloudApi('a' * 32, 'token', state, Opener(Response(body)))
            with self.subTest(method=method, suffix=suffix), self.assertRaises(DeploymentError):
                client.request(method, suffix, write='synthetic-domain-write' if method == 'POST' else None)
            self.assertEqual(state.attempted, method == 'POST')

    def test_account_zones_read_all_pages_without_writes_or_token_in_urls(self):
        rows = [{'id': f'{index:032x}'} for index in range(51)]
        opener = SequenceOpener([zone_page(1, rows[:50], 51), zone_page(2, rows[50:], 51)])
        state = self.state(); client = CloudApi('a' * 32, 'synthetic-token', state, opener)
        self.assertEqual(client.account_zones(), rows); self.assertFalse(state.attempted)
        self.assertEqual(len(opener.calls), 2)
        for page, call in enumerate(opener.calls, 1):
            url = urlparse(call.full_url)
            self.assertEqual(url.scheme + '://' + url.netloc + url.path, 'https://api.cloudflare.com/client/v4/zones')
            self.assertEqual(parse_qs(url.query), {'account.id': ['a' * 32], 'status': ['active'], 'per_page': ['50'], 'page': [str(page)]})
            self.assertNotIn('synthetic-token', call.full_url)

    def test_empty_zone_pagination_accepts_zero_or_one_total_pages(self):
        for pages in (0, 1):
            opener = SequenceOpener([zone_page(1, [], 0, pages)])
            with self.subTest(pages=pages):
                self.assertEqual(CloudApi('a' * 32, 'token', self.state(), opener).account_zones(), [])
                self.assertEqual(len(opener.calls), 1)

    def test_zone_pagination_rejects_incomplete_duplicate_and_changed_counts(self):
        rows = [{'id': f'{index:032x}'} for index in range(50)]
        cases = [[zone_page(1, rows, 51), zone_page(2, [rows[0]], 51)],
                 [zone_page(1, rows, 51), zone_page(2, [{'id': 'f' * 32}], 52)],
                 [zone_page(1, rows, 51), zone_page(2, [], 51)],
                 [zone_page(1, [], 1001)], [zone_page(1, [], 1, 0)]]
        for pages in cases:
            with self.subTest(pages=len(pages)), self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_ZONE_LIST_INCOMPLETE'):
                CloudApi('a' * 32, 'token', self.state(), SequenceOpener(pages)).account_zones()

    def test_malformed_zone_envelopes_and_authorization_failure_are_not_empty_zones(self):
        for key, value in [('page', 2), ('per_page', 20), ('count', 5), ('total_count', True), ('total_pages', True)]:
            page = zone_page(1, [], 0); page['result_info'][key] = value
            with self.subTest(key=key), self.assertRaises(DeploymentError):
                CloudApi('a' * 32, 'token', self.state(), SequenceOpener([page])).account_zones()
        error = urllib.error.HTTPError('https://api.cloudflare.com/client/v4/zones', 403, 'Forbidden', {}, None)
        opener = SequenceOpener([error])
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_CLOUD_REQUEST_FAILED'):
            CloudApi('a' * 32, 'token', self.state(), opener).account_zones()
        self.assertEqual(len(opener.calls), 1)

    def test_zone_root_is_readable_and_mutations_require_single_persisted_write_label(self):
        value = {'success': True, 'errors': [], 'result': {'id': 'b' * 32}}
        opener = SequenceOpener([value, value]); state = self.state(); client = CloudApi('a' * 32, 'token', state, opener)
        self.assertEqual(client.get('', zone='b' * 32), value['result'])
        self.assertEqual(opener.calls[0].full_url, 'https://api.cloudflare.com/client/v4/zones/' + 'b' * 32)
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_WRITE_JOURNAL_REQUIRED'):
            client.request('PUT', '/email/routing/rules/catch_all', {}, zone='b' * 32)
        self.assertFalse(state.attempted); self.assertEqual(len(opener.calls), 1)
        client.request('PUT', '/email/routing/rules/catch_all', {}, write='email-routing-bound', zone='b' * 32)
        self.assertTrue(state.attempted)
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_WRITE_REPLAY_REFUSED'):
            client.request('PUT', '/email/routing/rules/catch_all', {}, write='email-routing-bound', zone='b' * 32)
        self.assertEqual(len(opener.calls), 2)


if __name__ == '__main__':
    unittest.main()

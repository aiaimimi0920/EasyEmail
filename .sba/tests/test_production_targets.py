import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from production_domains import free_domains, recheck_domain
from email_routing import prepare_routing, bind_routing
from fixtures import configuration


def production_configuration():
    value = configuration()
    value['email']['origin'] = 'https://email-api.example.com'
    value['platform']['origin'] = 'https://mail.example.com'
    value['mailDomain'] = 'example.com'; value['routing'] = {'zoneId': 'b' * 32, 'domain': 'example.com'}
    return value


class TargetApi:
    def __init__(self):
        self.zone = {'id': 'b' * 32, 'name': 'example.com', 'account': {'id': 'a' * 32}, 'status': 'active'}
        self.rule = {'id': 'c' * 32, 'source': 'api', 'name': 'Synthetic catch-all', 'enabled': False,
                     'matchers': [{'type': 'all'}], 'actions': [{'type': 'drop'}]}
        self.dns, self.domains, self.writes, self.calls = [], [], [], []
        self.settings = {'id': 'b' * 32, 'name': 'example.com', 'enabled': True, 'status': 'ready'}
        self.lose_write = False; self.drift_after_write = False
        self.domain_total = 0

    def account_zones(self): return [copy.deepcopy(self.zone)]

    def get(self, suffix, zone=None):
        self.calls.append(('GET', suffix, zone))
        if zone is None: return copy.deepcopy(self.domains)
        if suffix == '': return copy.deepcopy(self.zone)
        if suffix == '/email/routing': return copy.deepcopy(self.settings)
        if suffix == '/email/routing/rules/catch_all':
            value = copy.deepcopy(self.rule)
            if self.writes and self.drift_after_write: value['enabled'] = False
            return value
        raise AssertionError(suffix)

    def request(self, method, suffix, payload=None, write=None, zone=None):
        self.calls.append((method, suffix, zone))
        if method == 'GET':
            if suffix.startswith('/workers/domains?'):
                return {'result': copy.deepcopy(self.domains), 'result_info': {
                    'page': 1, 'per_page': len(self.domains), 'count': len(self.domains), 'total_count': self.domain_total}}
            assert suffix.startswith('/dns_records?')
            return {'result': copy.deepcopy(self.dns), 'result_info': {
                'page': 1, 'count': len(self.dns), 'total_count': len(self.dns)}}
        assert method == 'PUT' and write == 'email-routing-bound'
        self.writes.append(copy.deepcopy(payload))
        if self.lose_write: raise DeploymentError('EASYEMAIL_CLOUD_REQUEST_FAILED')
        self.rule = {'id': self.rule['id'], **payload}
        return {'result': copy.deepcopy(self.rule)}


class ProductionTargetsTests(unittest.TestCase):
    def test_free_http_targets_are_read_only_and_selected_by_owning_zone(self):
        config, api = production_configuration(), TargetApi()
        targets = free_domains(config, api)
        self.assertEqual(set(targets), {'email', 'platform'})
        self.assertEqual(targets['platform'], {'zoneId': 'b' * 32, 'zoneName': 'example.com', 'hostname': 'mail.example.com'})
        recheck_domain(config, 'email', api, targets['email'])
        self.assertEqual(api.writes, [])
        self.assertEqual(free_domains(configuration(), api), {})

    def test_foreign_zone_existing_dns_or_domain_and_drift_refuse_publication(self):
        for change in ('account', 'zone', 'dns', 'domain', 'drift'):
            config, api = production_configuration(), TargetApi()
            targets = free_domains(config, api)
            if change == 'account': api.zone['account']['id'] = 'd' * 32
            if change == 'zone': api.zone['name'] = 'other.example.com'
            if change == 'dns': api.dns = [{'name': 'mail.example.com', 'type': 'A', 'content': '192.0.2.1'}]
            if change == 'domain': api.domains = [{'hostname': 'mail.example.com', 'service': 'foreign'}]
            if change == 'drift': api.zone['status'] = 'pending'
            with self.subTest(change=change), self.assertRaises(DeploymentError):
                recheck_domain(config, 'platform', api, targets['platform'])
            self.assertEqual(api.writes, [])

    def test_mail_dns_can_coexist_with_a_new_http_target_without_being_changed(self):
        config, api = production_configuration(), TargetApi()
        target = free_domains(config, api)['platform']
        api.dns = [{'name': 'mail.example.com', 'type': 'MX', 'content': 'route1.mx.cloudflare.net', 'priority': 10},
                   {'name': 'mail.example.com', 'type': 'TXT', 'content': 'v=spf1 include:_spf.mx.cloudflare.net ~all'}]
        before = copy.deepcopy(api.dns)
        recheck_domain(config, 'platform', api, target)
        self.assertEqual(api.dns, before)
        self.assertEqual(api.writes, [])

    def test_conflicting_or_unrecognized_dns_records_still_block_publication(self):
        config, api = production_configuration(), TargetApi()
        target = free_domains(config, api)['platform']
        for kind in ('A', 'AAAA', 'CNAME', 'NS', 'HTTPS', 'SVCB', 'SRV', 'unknown'):
            api.dns = [{'name': 'mail.example.com', 'type': kind, 'content': 'foreign.example.com'}]
            with self.subTest(kind=kind), self.assertRaises(DeploymentError):
                recheck_domain(config, 'platform', api, target)
        api.dns = [{'name': 'other.example.com', 'type': 'MX', 'content': 'route1.mx.cloudflare.net'}]
        with self.assertRaises(DeploymentError): recheck_domain(config, 'platform', api, target)
        self.assertEqual(api.writes, [])

    def test_truncated_dns_listing_cannot_hide_an_http_conflict(self):
        config, api = production_configuration(), TargetApi()
        target = free_domains(config, api)['platform']
        request = api.request
        def truncated(method, suffix, *args, **kwargs):
            value = request(method, suffix, *args, **kwargs)
            if suffix.startswith('/dns_records?'):
                value['result_info']['total_count'] += 1
            return value
        with patch.object(api, 'request', side_effect=truncated), self.assertRaises(DeploymentError):
            recheck_domain(config, 'platform', api, target)
        self.assertEqual(api.writes, [])

    def test_most_specific_owned_zone_wins_and_nonlabel_suffix_never_matches(self):
        config, api = production_configuration(), TargetApi()
        child = {**api.zone, 'id': 'd' * 32, 'name': 'app.example.com'}
        config['platform']['origin'] = 'https://mail.app.example.com'
        get = api.get
        def read(suffix, zone=None):
            return copy.deepcopy(child) if suffix == '' and zone == child['id'] else get(suffix, zone)
        with patch.object(api, 'account_zones', return_value=[api.zone, child]), patch.object(api, 'get', side_effect=read):
            targets = free_domains(config, api)
        self.assertEqual(targets['platform']['zoneId'], child['id'])
        self.assertEqual(targets['email']['zoneId'], api.zone['id'])
        config['email']['origin'] = 'https://badexample.com'
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_DOMAIN_ZONE_NOT_FOUND'): free_domains(config, api)

    def test_mail_binding_only_changes_exact_neutral_rule_once_and_reads_it_back(self):
        config, api = production_configuration(), TargetApi()
        before = prepare_routing(config, api)
        bind_routing(config, api, before)
        self.assertEqual(len(api.writes), 1)
        self.assertEqual(api.writes[0]['actions'], [{'type': 'worker', 'value': [config['email']['name']]}])
        self.assertTrue(api.rule['enabled']); self.assertEqual(api.rule['source'], 'api')
        self.assertEqual(api.calls[-1], ('GET', '/email/routing/rules/catch_all', 'b' * 32))
        with self.assertRaises(DeploymentError): bind_routing(config, api, before)
        self.assertEqual(len(api.writes), 1)

    def test_existing_owned_or_foreign_mail_route_is_never_adopted(self):
        for change in ('own-worker', 'foreign-worker', 'source', 'settings', 'matcher'):
            config, api = production_configuration(), TargetApi()
            if change.endswith('worker'):
                api.rule['enabled'] = True
                api.rule['actions'] = [{'type': 'worker', 'value': [config['email']['name'] if change == 'own-worker' else 'foreign']}]
            if change == 'source': api.rule['source'] = 'wrangler'
            if change == 'settings': api.settings['enabled'] = False
            if change == 'matcher': api.rule['matchers'] = [{'type': 'literal', 'value': 'user@example.com'}]
            with self.subTest(change=change), self.assertRaises(DeploymentError): prepare_routing(config, api)
            self.assertEqual(api.writes, [])

    def test_email_settings_identifier_does_not_need_to_equal_zone_identifier(self):
        config, api = production_configuration(), TargetApi()
        api.settings['id'] = 'd' * 32
        self.assertEqual(prepare_routing(config, api), api.rule)

    def test_incomplete_domain_list_is_not_evidence_that_hostname_is_free(self):
        config, api = production_configuration(), TargetApi(); api.domain_total = 1
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_DOMAIN_LIST_INCOMPLETE'):
            free_domains(config, api)
        self.assertEqual(api.writes, [])

    def test_lost_response_or_readback_drift_never_retries_or_reports_binding_success(self):
        for change in ('lost', 'drift'):
            config, api = production_configuration(), TargetApi(); before = prepare_routing(config, api)
            api.lose_write = change == 'lost'; api.drift_after_write = change == 'drift'
            with self.subTest(change=change), self.assertRaises(DeploymentError): bind_routing(config, api, before)
            self.assertEqual(len(api.writes), 1)

    def test_neutral_rule_metadata_drift_blocks_the_write_and_null_route_is_noop(self):
        config, api = production_configuration(), TargetApi(); before = prepare_routing(config, api)
        api.rule['name'] = 'Changed by another owner'
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_EMAIL_ROUTE_CHANGED'): bind_routing(config, api, before)
        self.assertEqual(api.writes, [])
        api.calls.clear(); config['routing'] = None
        self.assertIsNone(prepare_routing(config, api)); bind_routing(config, api, None)
        self.assertEqual(api.calls, []); self.assertEqual(api.writes, [])


if __name__ == '__main__': unittest.main()

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from deployment_secrets import deployment_secrets
from runtime_acceptance import email_version, migrate_email, verify_administrator
from fixtures import configuration
from test_deploy_secrets import secret_environment


class Runtime:
    def __init__(self, fault=None): self.calls = []; self.fault = fault
    def request(self, role, path, **kwargs):
        self.calls.append((role, path, kwargs))
        if path.endswith('db_version'):
            return {'need_initialization': False, 'need_migration': False, 'code_db_version': 'v0.0.9',
                    'current_db_version': 'v0.0.8' if self.fault == 'version' else 'v0.0.9'}, {}
        if path.endswith('db_migration'): return {'success': self.fault != 'migration'}, {}
        if path.endswith('auth/login'):
            return {'user': {'id': 'a' * 8 + '-aaaa-aaaa-aaaa-' + 'a' * 12, 'username': 'admin'}}, {
                'set-cookie': '__Host-ee_session=es_' + 'b' * 64 + '; Secure; HttpOnly; SameSite=Strict; Path=/'}
        if path.endswith('admin/providers'):
            if self.fault == 'admin': raise DeploymentError('EASYEMAIL_CLOUD_REQUEST_FAILED')
            return {'items': [{'config': {'id': 'self', 'baseUrl': configuration()['email']['origin']}, 'secret': {'configured': True}}]}, {}
        if path.endswith('self/probe'): return {'health': {'state': 'error' if self.fault == 'probe' else 'ok', 'error': None}}, {}
        if path.endswith('auth/logout'): return {'ok': True}, {}
        raise AssertionError(path)


class RuntimeAcceptanceTests(unittest.TestCase):
    def test_email_version_and_native_migration_are_checked_without_reinitialization(self):
        material = deployment_secrets(configuration(), secret_environment()); runtime = Runtime()
        email_version(material, runtime); migrate_email(material, runtime)
        self.assertEqual([path for _, path, _ in runtime.calls], ['/admin/db_version', '/admin/db_migration', '/admin/db_version'])
        self.assertEqual(runtime.calls[1][2]['write'], 'update-email-migrated')
        for fault in ('migration', 'version'):
            with self.subTest(fault=fault), self.assertRaises(DeploymentError): migrate_email(material, Runtime(fault))

    def test_existing_admin_authentication_never_registers_resets_or_grants_and_closes_session_on_failure(self):
        material = deployment_secrets(configuration(), secret_environment())
        for fault in (None, 'admin', 'probe'):
            runtime = Runtime(fault)
            if fault:
                with self.assertRaises(DeploymentError): verify_administrator(configuration(), material, runtime)
            else: verify_administrator(configuration(), material, runtime)
            self.assertEqual(runtime.calls[-1][1], '/api/v1/auth/logout')
            self.assertFalse(any('register' in path or 'password' in path for _, path, _ in runtime.calls))


if __name__ == '__main__': unittest.main()
